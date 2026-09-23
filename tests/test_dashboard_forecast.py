"""Offline contract checks for the unified web workflow and artifact projection."""
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from wind_forecast.agent.dashboard import DashboardService, make_handler
from wind_forecast.agent.forecast_service import ForecastService


class UnifiedForecastTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.forecasts = ForecastService(self.root, scheduler=False)
        config = {"issue_time": "2026-02-01T01:00:00+00:00", "mode": "fixture", "weather_source": "mock"}
        config_path = self.root / "config.json"
        config_path.write_text(json.dumps(config))
        self.dashboard = DashboardService(config_path, forecasts=self.forecasts)
        self.dashboard.root = self.root

    def tearDown(self):
        self.forecasts.stop_event.set()
        self.forecasts.executor.shutdown(wait=True)
        self.temporary.cleanup()

    def await_job(self, job):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            job = self.forecasts.get(job["id"])
            if job["state"] not in {"queued", "running"}:
                return job
            time.sleep(0.02)
        self.fail("Forecast worker did not complete")

    def fixture(self, **overrides):
        return self.await_job(self.forecasts.submit({"mode": "fixture", "horizon_hours": 24, **overrides}))

    def test_page_snapshot_never_starts_forecast(self):
        snapshot = self.dashboard.snapshot("date", "2026-02-01")
        self.assertNotIn("forecast", snapshot)
        self.assertEqual(len(snapshot["turbines"]), 2)
        self.assertEqual(self.forecasts.jobs, {})

    def test_fixture_job_export_and_selected_projection(self):
        job = self.fixture(turbine_ids=["T1"])
        self.assertEqual(job["state"], "completed", job.get("error"))
        result = job["result"]
        self.assertTrue(result["is_synthetic"])
        self.assertEqual(len(result["rows"]), 24)
        self.assertTrue(result["trace"])
        self.assertIsNotNone(result["rows"][0]["wind_ms"])
        self.assertIn("?run_id=", result["downloads"]["csv"])
        snapshot = self.dashboard.snapshot("date", "2026-02-01", run_id=result["run_id"])
        self.assertEqual(snapshot["forecast"]["modelId"], result["model_id"])
        self.assertTrue(any(row["predictedPower"] is not None for row in snapshot["turbines"][0]["history"]))
        self.assertTrue(all(row["predictedPower"] is None for row in snapshot["turbines"][1]["history"]))
        self.assertEqual(len(snapshot["turbines"][0]["history"]), 24)
        csv_data, mime, filename = self.forecasts.download(job["id"], "csv", result["run_id"])
        self.assertEqual(len(csv_data.splitlines()), 25)
        self.assertIn("text/csv", mime)
        archive, _, _ = self.forecasts.download(job["id"], "zip", result["run_id"])
        self.assertTrue(archive.startswith(b"PK"))
        with self.assertRaises(KeyError):
            self.forecasts.download(job["id"], "csv", "unrelated-run")

    def test_unchanged_refresh_does_not_create_another_forecast(self):
        job = self.fixture()
        version = job["result"]["run_id"]
        refreshed = self.await_job(self.forecasts.refresh(job["id"]))
        self.assertEqual(refreshed["state"], "completed")
        self.assertEqual(refreshed["monitor"]["state"], "unchanged")
        self.assertEqual(refreshed["result"]["run_id"], version)
        self.assertEqual(len(list((self.root / "runs/application").iterdir())), 1)

    def test_browser_cannot_supply_executable_or_filesystem_inputs(self):
        for field in ("model_factory", "weather_factory", "data_paths", "output_root", "cache_dir", "model_path"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.forecasts.submit({"mode": "fixture", field: "attacker-value"})

    def test_catboost_requires_daily_time_and_acknowledged_convention(self):
        for changes in ({"issue_time": "2026-02-01T00:00:00Z"}, {"source_timezone": "UTC"}, {"mode": "live"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.forecasts.submit({"model_kind": "local_history", "assumptions_confirmed": True, **changes})

    def test_upload_name_cannot_choose_storage_path(self):
        path = Path(self.forecasts._upload({"name": "../../escape.csv", "content": "a,b\n1,2\n"}, ".csv"))
        self.assertEqual(path.parent, self.root / "data/cache/uploads")
        self.assertFalse((self.root / "escape.csv").exists())

    def test_http_async_endpoints(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.dashboard, self.root))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(origin + "/runtime-config.json") as response:
                self.assertTrue(json.load(response)["unifiedForecast"])
            request = Request(origin + "/api/forecast", data=b'{"mode":"fixture"}', headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(request) as response:
                self.assertEqual(response.status, 202)
                job = self.await_job(json.load(response))
            with urlopen(origin + "/api/forecast/" + job["id"]) as response:
                self.assertEqual(json.load(response)["state"], "completed")
            request = Request(origin + "/api/forecast/" + job["id"] + "/refresh", data=b'{}', headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(request) as response:
                self.assertEqual(response.status, 202)
            request = Request(origin + "/api/forecast", data=b'{"model_factory":"bad"}', headers={"Content-Type": "application/json"}, method="POST")
            with self.assertRaises(HTTPError) as failure:
                urlopen(request)
            self.assertEqual(failure.exception.code, 422)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
