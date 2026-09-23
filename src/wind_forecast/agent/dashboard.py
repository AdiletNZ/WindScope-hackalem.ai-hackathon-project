"""Serve the unified React dashboard and the shared Python forecast workflow."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
import json
import mimetypes
from pathlib import Path
import threading
from urllib.parse import parse_qs, unquote, urlparse
from zoneinfo import ZoneInfo

from wind_forecast.agent.application import _safe_error, load_datasets
from wind_forecast.agent.forecast_service import ForecastService, MAX_BODY_BYTES
from wind_forecast.agent.settings import CASE_COORDINATES, RunConfig, parse_time

ZONE = ZoneInfo("Etc/GMT-5")
SITE_IDS = {"T1": "turbine_1", "T2": "turbine_2"}
ROOT = Path(__file__).resolve().parents[3]


class DashboardService:
    """Read-only projections of observations and explicitly selected run artifacts."""

    def __init__(self, config_path, forecasts=None):
        self.config_path = Path(config_path).resolve()
        self.root = ROOT
        self.forecasts = forecasts or ForecastService(self.root, data_paths=json.loads(self.config_path.read_text()).get("data_paths", {}))
        self.lock = threading.RLock()
        self.dataset_cache = {}

    def base_config(self):
        raw = json.loads(self.config_path.read_text())
        raw["data_paths"] = {t: str(Path(p) if Path(p).is_absolute() else self.root / p)
                             for t, p in raw.get("data_paths", {}).items()}
        return RunConfig.from_dict(raw)

    def datasets(self, config):
        # Keep both map sites visible even when only one turbine was forecast.
        paths = dict(config.data_paths)
        for turbine in SITE_IDS:
            fallback = Path(self.forecasts.data_paths[turbine])
            if turbine not in paths and fallback.is_file() and config.mode != "fixture":
                paths[turbine] = str(fallback)
        selected = tuple(SITE_IDS) if config.mode == "fixture" else tuple(t for t in SITE_IDS if t in paths and Path(paths[t]).is_file())
        if not selected:
            return {}
        key = (config.mode, config.source_timezone, config.interval_label, config.reporting_delay_minutes,
               config.input_format, tuple((t, p, Path(p).stat().st_mtime_ns, Path(p).stat().st_size)
                                         for t, p in sorted(paths.items()) if Path(p).is_file()))
        with self.lock:
            if key not in self.dataset_cache:
                datasets = load_datasets(replace(config, turbine_ids=selected, data_paths=paths))
                if len(self.dataset_cache) >= 6:
                    self.dataset_cache.clear()
                self.dataset_cache[key] = datasets
            return self.dataset_cache[key]

    def snapshot(self, period="today", selected_date=None, issue=None, run_id=None):
        if period not in {"today", "yesterday", "date"}:
            raise ValueError("Unknown period")
        if period == "date" and not selected_date:
            raise ValueError("date parameter required")
        if period != "date" and selected_date:
            raise ValueError("Use period=date for an archived date")
        response, weather = None, None
        if run_id:
            config, response, weather = self.forecasts.selected(run_id)
        else:
            config = self.base_config()
        # Legacy issue queries select existing artifacts only; viewing never trains.
        if issue and not run_id:
            target = parse_time(issue)
            for candidate in sorted(self.forecasts.output_root.glob("*/request.json"), key=lambda p: p.stat().st_mtime_ns, reverse=True):
                try:
                    candidate_config, candidate_response, candidate_weather = self.forecasts.selected(candidate.parent.name)
                    if candidate_config.issue_time == target:
                        config, response, weather = candidate_config, candidate_response, candidate_weather
                        break
                except (ValueError, KeyError, OSError):
                    continue
        datasets = self.datasets(config)
        now = datetime.now(timezone.utc)
        local_today = now.astimezone(ZONE).date()
        day = (datetime.strptime(selected_date, "%Y-%m-%d").date() if selected_date
               else local_today - timedelta(days=period == "yesterday"))
        start = datetime.combine(day, datetime.min.time(), ZONE)
        report = response["report"] if response else {}
        result = response["result"] if response else None
        prediction = {(r["turbine_id"], parse_time(r["valid_time"])): r for r in result["rows"]} if result else {}
        wind = {(r["turbine_id"], parse_time(r["valid_time"])): r["wind_ms"] for r in report.get("wind_forecast", [])}
        weather_rows = {(r["turbine_id"], parse_time(r["valid_time"])): r for r in weather.get("rows", [])} if weather else {}
        turbines = []
        for turbine, frontend_id in SITE_IDS.items():
            dataset = datasets.get(turbine)
            observed = {o.observed_at: o for o in dataset.observations
                        if o.available_at <= now and o.observed_at <= now and o.quality_flag == "ok"} if dataset else {}
            history = []
            for hour in range(24):
                interval = start + timedelta(hours=hour)
                end = interval + timedelta(hours=1)
                observation = observed.get(end)
                forecast = prediction.get((turbine, end))
                if forecast and parse_time(forecast["issue_time"]) > interval:
                    forecast = None
                point = weather_rows.get((turbine, end), {}) if forecast else {}
                history.append({"time": interval.isoformat(timespec="seconds"),
                                "actualPower": observation.power_norm if observation else None,
                                "predictedPower": forecast["prediction"] if forecast else None,
                                "actualTemperature": observation.temp_c if observation else None,
                                "predictedTemperature": point.get("temp_c"),
                                "actualWindSpeed": observation.wind_ms if observation else None,
                                "predictedWindSpeed": point.get("wind_ms", wind.get((turbine, end))) if forecast else None,
                                "actualWindDirection": None,
                                "predictedWindDirection": point.get("wind_direction_deg")})
            lat, lon = CASE_COORDINATES[turbine]
            turbines.append({"id": frontend_id, "name": f"Turbine {turbine[1:]} (SCADA {turbine})",
                             "latitude": lat, "longitude": lon, "status": "unknown", "history": history})
        payload = {"schemaVersion": 1, "provenance": "synthetic" if config.mode == "fixture" else "local_scada",
                   "generatedAt": now.isoformat(timespec="seconds"), "timezone": "Asia/Qyzylorda",
                   "date": day.isoformat(), "period": period, "turbines": turbines, "events": []}
        if response:
            payload["forecast"] = {"issueTime": response["request"]["issue_time"], "modelId": result["model_id"],
                                   "windModelId": report.get("wind_model", {}).get("model_id", "Weather forecast" if weather else "Unavailable"),
                                   "horizonHours": response["request"]["horizon_hours"], "runId": Path(response["run_dir"]).name,
                                   "latestObservation": report.get("observations", {}).get("latest_hour_end") or "",
                                   "note": "Synthetic demonstration." if result["is_synthetic"] else "Original CSV measurements under acknowledged timestamp assumptions. Forecast values come from the selected saved run; unknown readings and operational status remain empty."}
        return payload


def make_handler(service, static_root):
    static_root = Path(static_root).resolve()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            try:
                if parsed.path == "/healthz":
                    return self.send_json({"status": "ok"})
                if parsed.path == "/runtime-config.json":
                    return self.send_json({"dataMode": "api", "apiUrl": "/api/dashboard", "backendUrl": "",
                                           "defaultDate": service.base_config().issue_time.astimezone(ZONE).date().isoformat(),
                                           "unifiedForecast": True})
                if parsed.path == "/api/forecast/options":
                    return self.send_json(service.forecasts.options())
                if parsed.path == "/api/dashboard":
                    return self.send_json(service.snapshot(query.get("period", ["today"])[0], query.get("date", [None])[0],
                                                           query.get("issue", [None])[0], query.get("run_id", [None])[0]))
                parts = parsed.path.strip("/").split("/")
                if len(parts) == 3 and parts[:2] == ["api", "forecast"]:
                    return self.send_json(service.forecasts.get(parts[2]))
                if len(parts) == 5 and parts[:2] == ["api", "forecast"] and parts[3] == "download":
                    content, mime, name = service.forecasts.download(parts[2], parts[4], query.get("run_id", [None])[0])
                    return self.send_bytes(content, mime, attachment=name)
                if parsed.path.startswith("/api/"):
                    return self.send_json({"error": "Not found"}, 404)
                path = (static_root / unquote(parsed.path).lstrip("/")).resolve()
                if not path.is_relative_to(static_root):
                    return self.send_json({"error": "Not found"}, 404)
                if not path.is_file():
                    path = static_root / "index.html"
                if not path.is_file():
                    return self.send_json({"error": "Build the React frontend with npm run build first"}, 503)
                return self.send_bytes(path.read_bytes(), mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            except KeyError:
                self.send_json({"error": "Forecast not found"}, 404)
            except (ValueError, FileNotFoundError) as exc:
                self.send_json({"error": _safe_error(exc)}, 422)
            except Exception as exc:
                self.send_json({"error": _safe_error(exc)}, 500)

        def read_body(self):
            if self.headers.get_content_type() != "application/json":
                raise ValueError("Send application/json")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as exc:
                raise ValueError("Invalid request body length") from exc
            if not 0 < length <= MAX_BODY_BYTES:
                self.close_connection = True
                raise ValueError("Forecast request must contain JSON and be no larger than 55 MB")
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict):
                raise ValueError("Request body must be a JSON object")
            return value

        def do_POST(self):
            self.mutate()

        def do_PATCH(self):
            self.mutate()

        def mutate(self):
            try:
                parts = urlparse(self.path).path.strip("/").split("/")
                body = self.read_body()
                if self.command == "POST" and parts == ["api", "forecast"]:
                    return self.send_json(service.forecasts.submit(body), 202)
                if len(parts) == 4 and parts[:2] == ["api", "forecast"]:
                    if self.command == "POST" and parts[3] == "refresh":
                        return self.send_json(service.forecasts.refresh(parts[2]), 202)
                    if self.command == "PATCH" and parts[3] == "monitor":
                        if set(body) != {"enabled"}:
                            raise ValueError("Provide the enabled boolean")
                        return self.send_json(service.forecasts.set_monitor(parts[2], body["enabled"]))
                return self.send_json({"error": "Not found"}, 404)
            except KeyError:
                self.send_json({"error": "Forecast not found"}, 404)
            except (ValueError, TypeError, FileNotFoundError) as exc:
                self.send_json({"error": _safe_error(exc)}, 422)
            except Exception as exc:
                self.send_json({"error": _safe_error(exc)}, 500)

        def send_json(self, value, status=200):
            self.send_bytes(json.dumps(value, allow_nan=False).encode(), "application/json", status)

        def send_bytes(self, payload, mime, status=200, attachment=None):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Cache-Control", "no-store")
            if attachment:
                self.send_header("Content-Disposition", f'attachment; filename="{attachment}"')
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="examples/local_request.json")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--static", type=Path, default=Path("frontend/dist"))
    args = parser.parse_args()
    service = DashboardService(args.config)
    print(f"Unified dashboard and forecast workflow: http://{args.host}:{args.port}", flush=True)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(service, args.static))
    try:
        server.serve_forever()
    finally:
        service.forecasts.stop_event.set()
        service.forecasts.executor.shutdown(wait=False, cancel_futures=True)
        server.server_close()


if __name__ == "__main__":
    main()
