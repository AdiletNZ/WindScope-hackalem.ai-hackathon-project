"""Bounded HTTP input adapter and persistent jobs for the unified dashboard.

Every numerical run uses the same RunConfig, run_forecast and ForecastMonitor
as Streamlit. Browser input can supply data, never executable factories or paths.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from importlib.util import find_spec
import hashlib
import io
import json
from pathlib import Path
import re
import threading
from uuid import uuid4
import zipfile

from wind_forecast.agent.application import _safe_error, json_safe
from wind_forecast.agent.monitor import ForecastMonitor, _atomic_json
from wind_forecast.agent.settings import RunConfig, parse_time, runtime_settings

MAX_BODY_BYTES = 55 * 1024 * 1024
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")
PUBLIC_FIELDS = (
    "mode", "model_kind", "issue_time", "horizon_hours", "turbine_ids",
    "source_timezone", "interval_label", "reporting_delay_minutes",
    "assumptions_confirmed", "observation_policy", "weather_source", "wind_height_m",
    "controller", "jev_enabled", "operational_notes",
)


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


class ForecastService:
    def __init__(self, root: Path, *, data_paths=None, scheduler=True):
        self.root = Path(root).resolve()
        self.data_paths = {t: str(Path(p) if Path(p).is_absolute() else self.root / p)
                           for t, p in (data_paths or {}).items()}
        for turbine in ("T1", "T2"):
            self.data_paths.setdefault(turbine, str(self.root / f"data/raw/turbine_{turbine[1:]}.csv"))
        self.jobs_root = self.root / "runs/dashboard_jobs"
        self.output_root = self.root / "runs/application"
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="wind-forecast")
        self.jobs = {}
        self.stop_event = threading.Event()
        for path in self.jobs_root.glob("*/job.json"):
            try:
                job = _read_json(path)
                if not SAFE_ID.fullmatch(job["id"]):
                    continue
                # Restart preserves completed artifacts; resume is an explicit action.
                job["monitor"]["enabled"] = False
                if job["state"] in {"running", "queued"}:
                    job.update(state="failed", phase="Interrupted by server restart", error="The server restarted during this run. Generate a new forecast or check inputs again.")
                self.jobs[job["id"]] = job
            except (KeyError, ValueError, OSError, TypeError):
                continue
        if scheduler:
            threading.Thread(target=self._schedule, daemon=True, name="wind-monitor").start()

    def options(self):
        runtime = runtime_settings()
        artifacts = self.root / "src/wind_forecast/models/artifacts"
        artifact_paths = ["deploy-final/catboost_neighbor.cbm", "deploy-final/catboost_neighbor.metadata.json",
                          "wind-audit/wind_model.joblib", "wind-audit/metadata.json"]
        catboost_ready = find_spec("catboost") is not None and all((artifacts / p).is_file() for p in artifact_paths)
        return {"schemaVersion": 1,
                "models": [
                    {"id": "gradient_boosting", "label": "Gradient Boosting", "available": find_spec("sklearn") is not None, "reason": None},
                    {"id": "local_history", "label": "CatBoost", "available": catboost_ready,
                     "reason": None if catboost_ready else "Install the local model dependencies and saved model artifacts."}],
                "defaults": {"issue_time": "2026-02-01T01:00:00+00:00", "horizon_hours": 24,
                             "turbine_ids": ["T1", "T2"], "source_timezone": "Etc/GMT-5",
                             "interval_label": "start", "reporting_delay_minutes": 0, "observation_policy": "available"},
                "measurements": {t: {"available": Path(self.data_paths[t]).is_file(),
                                      "name": Path(self.data_paths[t]).name} for t in ("T1", "T2")},
                "capabilities": {"openai": bool(runtime["api_key"] and find_spec("openai")),
                                 "jev": bool(runtime["typesafe_api_key"]), "auto_refresh": True},
                "sources": [{"id": "noaa_gfs", "label": "NOAA GFS archive (automatic)",
                             "url": "https://registry.opendata.aws/noaa-gfs-bdp/"},
                            {"id": "bundles", "label": "Upload a weather bundle"}]}

    def _upload(self, item, suffix):
        if not isinstance(item, dict) or set(item) - {"name", "content"} or not isinstance(item.get("content"), str):
            raise ValueError("Uploads must contain a name and UTF-8 text content")
        data = item["content"].encode("utf-8")
        if not data or len(data) > MAX_UPLOAD_BYTES:
            raise ValueError("Each upload must contain between 1 byte and 25 MB")
        if suffix == ".json":
            bundle = json.loads(data.decode("utf-8-sig"))
            if not isinstance(bundle, dict):
                raise ValueError("Upload a complete weather.json bundle")
        directory = self.root / "data/cache/uploads"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / (hashlib.sha256(data).hexdigest() + suffix)
        if not path.exists():
            path.write_bytes(data)
        return str(path)

    def _config(self, raw):
        if not isinstance(raw, dict):
            raise ValueError("Forecast request must be a JSON object")
        allowed = set(PUBLIC_FIELDS) | {"uploads", "weather_upload", "auto_refresh"}
        unknown = set(raw) - allowed
        if unknown:
            raise ValueError("Unknown forecast fields: " + ", ".join(sorted(unknown)))
        mode = raw.get("mode", "historical")
        model = raw.get("model_kind", "gradient_boosting")
        if model not in {"gradient_boosting", "local_history"}:
            raise ValueError("Choose Gradient Boosting or CatBoost")
        if mode not in {"fixture", "historical", "live"}:
            raise ValueError("Choose demo, historical, or live mode")
        for key in ("auto_refresh", "jev_enabled", "assumptions_confirmed"):
            if key in raw and type(raw[key]) is not bool:
                raise ValueError(key + " must be a boolean")
        turbines = raw.get("turbine_ids", ["T1", "T2"])
        if not isinstance(turbines, list) or not turbines or any(t not in {"T1", "T2"} for t in turbines):
            raise ValueError("Select T1, T2, or both turbines")
        issue = parse_time(raw.get("issue_time", "2026-02-01T01:00:00+00:00"))
        if mode == "live":
            issue = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        local = model == "local_history" and mode != "fixture"
        if local and (mode != "historical" or issue.hour != 1):
            raise ValueError("CatBoost uses a historical daily issue at 01:00 UTC (06:00 UTC+5)")
        if mode != "fixture" and not raw.get("assumptions_confirmed", False):
            raise ValueError("Confirm the source CSV timestamp assumptions before forecasting")
        source_timezone = raw.get("source_timezone", "Etc/GMT-5")
        interval_label = raw.get("interval_label", "start")
        if local and (source_timezone != "Etc/GMT-5" or interval_label != "start"):
            raise ValueError("Saved CatBoost models require UTC+5 and interval-start CSV timestamps")
        uploads = raw.get("uploads", {})
        if not isinstance(uploads, dict) or set(uploads) - {"T1", "T2"}:
            raise ValueError("Measurement uploads must be keyed by T1 or T2")
        paths = {}
        if mode != "fixture":
            for turbine in (("T1", "T2") if local else turbines):
                paths[turbine] = (self._upload(uploads[turbine], ".csv") if turbine in uploads
                                  else self.data_paths[turbine])
                if not Path(paths[turbine]).is_file():
                    raise ValueError(f"Upload a measurement CSV for {turbine}")
        weather_source = raw.get("weather_source", "noaa_gfs")
        if weather_source not in {"noaa_gfs", "bundles", "none", "mock"}:
            raise ValueError("Select NOAA weather or upload a weather bundle")
        weather_path = ""
        if mode == "fixture":
            weather_source = "mock"
        elif local:
            weather_source = "none"
        elif weather_source == "bundles":
            if not raw.get("weather_upload"):
                raise ValueError("Upload the exported weather.json bundle")
            weather_path = self._upload(raw["weather_upload"], ".json")
        elif weather_source != "noaa_gfs":
            raise ValueError("Gradient Boosting requires NOAA weather or an uploaded weather bundle")
        controller = raw.get("controller", "deterministic")
        jev = raw.get("jev_enabled", False)
        if (local or mode == "fixture") and (controller != "deterministic" or jev):
            raise ValueError("OpenAI and Jev are available for real Gradient Boosting forecasts")
        runtime = runtime_settings()
        if controller == "openai" and not (runtime["api_key"] and find_spec("openai")):
            raise ValueError("Configure OPENAI_API_KEY and install the OpenAI SDK on the server")
        if jev and not runtime["typesafe_api_key"]:
            raise ValueError("Configure TYPESAFE_API_KEY on the server to use Jev")
        notes = raw.get("operational_notes", [])
        if not isinstance(notes, list) or len(notes) > 8 or len(json.dumps(notes)) > 32768:
            raise ValueError("Provide at most eight short operator notes")
        config = RunConfig(issue_time=issue, turbine_ids=tuple(turbines), horizon_hours=raw.get("horizon_hours", 24),
                           mode=mode, model_kind="empirical" if mode == "fixture" else model,
                           data_paths=paths, source_timezone=source_timezone, interval_label=interval_label,
                           reporting_delay_minutes=raw.get("reporting_delay_minutes", 0),
                           assumptions_confirmed=raw.get("assumptions_confirmed", False),
                           observation_policy=raw.get("observation_policy", "available"),
                           weather_source=weather_source, weather_path=weather_path,
                           wind_height_m=raw.get("wind_height_m", 100), controller=controller,
                           jev_enabled=jev, jev_model=runtime["typesafe_model"], operational_notes=tuple(notes),
                           output_root=str(self.output_root), cache_dir=str(self.root / "data/cache/weather"))
        if jev:
            from wind_forecast.agent.jev import _notes
            _notes(config)
        return config

    def _save(self, job):
        _atomic_json(self.jobs_root / job["id"] / "job.json", job)

    def submit(self, raw):
        config = self._config(raw)
        job_id = uuid4().hex
        with self.lock:
            if sum(job["state"] in {"queued", "running"} for job in self.jobs.values()) >= 4:
                raise ValueError("Four forecasts are already queued. Wait for one to finish.")
            directory = self.jobs_root / job_id
            directory.mkdir()
            _atomic_json(directory / "config.json", config.to_dict())
            now = _now()
            job = {"id": job_id, "state": "queued", "phase": "Waiting to start", "created_at": now,
                   "updated_at": now, "error": None,
                   "config": {key: value for key, value in config.to_dict().items() if key in PUBLIC_FIELDS},
                   "result": None, "monitor": {"enabled": raw.get("auto_refresh", False), "state": "pending",
                                               "next_check_at": None, "error": None, "reasons": []}}
            self.jobs[job_id] = job
            self._save(job)
            self.executor.submit(self._execute, job_id, False)
            return json.loads(json.dumps(job))

    def get(self, job_id):
        with self.lock:
            if not SAFE_ID.fullmatch(job_id) or job_id not in self.jobs:
                raise KeyError("Forecast job not found")
            return json.loads(json.dumps(self.jobs[job_id]))

    def _execute(self, job_id, force):
        with self.lock:
            job = self.jobs[job_id]
            job.update(state="running", phase="Checking inputs and running the forecast", updated_at=_now(), error=None)
            self._save(job)
        try:
            config = RunConfig.from_dict(_read_json(self.jobs_root / job_id / "config.json"))
            monitor = ForecastMonitor(self.jobs_root / job_id / "monitor", rolling_live=config.mode == "live")
            if force:
                state = monitor.load_state()
                state.pop("next_check_at", None)
                _atomic_json(monitor.state_path, state)
            poll = monitor.poll(config)
            result = self._normalize_run(job_id, poll.run) if poll.run and poll.run.state == "completed" else None
            with self.lock:
                job = self.jobs[job_id]
                if result:
                    job["result"] = result
                state = "completed" if poll.state in {"unchanged", "waiting", "busy"} and job["result"] else poll.state
                if state not in {"completed", "blocked", "failed"}:
                    state = "failed"
                job.update(state=state,
                           phase=("Forecast ready" if result else "Inputs unchanged" if poll.state == "unchanged"
                                  else "Forecast could not complete" if poll.error else "Waiting for the next input check"),
                           updated_at=_now(), error=poll.error)
                job["monitor"].update(state=poll.state, next_check_at=poll.next_check_at.isoformat() if poll.next_check_at else None,
                                      error=poll.error, reasons=list(poll.reasons))
                self._save(job)
        except Exception as exc:
            with self.lock:
                job = self.jobs[job_id]
                job.update(state="failed", phase="Forecast could not complete", updated_at=_now(), error=_safe_error(exc))
                job["monitor"].update(state="failed", error=job["error"],
                                      next_check_at=(datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat())
                self._save(job)

    def _normalize_run(self, job_id, run):
        response = run.to_dict()
        wind = {(r["turbine_id"], parse_time(r["valid_time"])): r["wind_ms"] for r in run.report.get("wind_forecast", [])}
        weather = {(r.turbine_id, r.valid_time): r for r in run.weather.rows} if run.weather else {}
        rows = []
        for row in response["result"]["rows"]:
            key = (row["turbine_id"], parse_time(row["valid_time"]))
            point = weather.get(key)
            rows.append({**row, "wind_ms": point.wind_ms if point else wind.get(key),
                         "temp_c": point.temp_c if point else None,
                         "wind_direction_deg": point.wind_direction_deg if point else None})
        return {"run_id": run.run_dir.name, "issue_time": run.request.issue_time.isoformat(),
                "horizon_hours": run.request.horizon_hours, "model_id": run.result.model_id,
                "is_synthetic": run.result.is_synthetic, "status": run.result.status,
                "warnings": list(run.result.warnings), "summary": run.summary, "rows": rows,
                "report": response["report"], "trace": json_safe(run.trace.events), "operations": run.report.get("operations"),
                "downloads": {kind: f"/api/forecast/{job_id}/download/{kind}?run_id={run.run_dir.name}" for kind in ("csv", "zip")},
                "dashboard_date": (run.request.issue_time + timedelta(hours=5)).date().isoformat()}

    def refresh(self, job_id):
        with self.lock:
            self.get(job_id)
            job = self.jobs[job_id]
            if job["state"] not in {"queued", "running"}:
                job.update(state="queued", phase="Checking for updated inputs", error=None, updated_at=_now())
                self._save(job)
                self.executor.submit(self._execute, job_id, True)
            return self.get(job_id)

    def set_monitor(self, job_id, enabled):
        if type(enabled) is not bool:
            raise ValueError("enabled must be a boolean")
        with self.lock:
            self.get(job_id)
            self.jobs[job_id]["monitor"]["enabled"] = enabled
            self._save(self.jobs[job_id])
            return self.get(job_id)

    def _schedule(self):
        while not self.stop_event.wait(2):
            with self.lock:
                now = datetime.now(timezone.utc)
                for job_id, job in self.jobs.items():
                    due = job["monitor"].get("next_check_at")
                    if job["monitor"]["enabled"] and job["state"] not in {"queued", "running"} and (not due or parse_time(due) <= now):
                        job.update(state="queued", phase="Checking for updated inputs", updated_at=_now())
                        self.executor.submit(self._execute, job_id, False)

    def selected(self, identifier):
        """Return trusted saved config/result without running a forecast."""
        if not SAFE_ID.fullmatch(identifier):
            raise KeyError("Forecast not found")
        with self.lock:
            if identifier in self.jobs:
                job = self.jobs[identifier]
                if not job["result"]:
                    raise ValueError("This forecast has not completed yet")
                identifier = job["result"]["run_id"]
        directory = self.output_root / identifier
        if not directory.is_dir():
            raise KeyError("Forecast not found")
        response = _read_json(directory / "response.json")
        if response["state"] != "completed":
            raise ValueError("This forecast has not completed")
        config = RunConfig.from_dict(_read_json(directory / "request.json"))
        weather = _read_json(directory / "weather.json") if (directory / "weather.json").is_file() else None
        return config, response, weather

    def download(self, job_id, kind, run_id=None):
        job = self.get(job_id)
        result = job["result"]
        if not result:
            raise ValueError("No completed forecast is available to download")
        if run_id:
            if not SAFE_ID.fullmatch(run_id):
                raise KeyError("Download not found")
            # A version belongs to this job only if its monitor history emitted it.
            history_path = self.jobs_root / job_id / "monitor/history.jsonl"
            allowed = {result["run_id"]}
            if history_path.is_file():
                for line in history_path.read_text().splitlines():
                    event = json.loads(line)
                    if event.get("state") == "completed" and event.get("run_dir"):
                        allowed.add(Path(event["run_dir"]).name)
            if run_id not in allowed:
                raise KeyError("Download not found")
        version = run_id or result["run_id"]
        directory = self.output_root / version
        if kind == "csv":
            return (directory / "forecast.csv").read_bytes(), "text/csv; charset=utf-8", version + ".csv"
        if kind != "zip":
            raise KeyError("Download not found")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(directory.iterdir()):
                if path.is_file() and not path.is_symlink() and path.suffix in {".csv", ".json", ".jsonl", ".md"}:
                    archive.writestr(path.name, path.read_bytes())
        return buffer.getvalue(), "application/zip", version + ".zip"
