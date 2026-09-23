# One website: forecast studio and turbine dashboard

Open **http://127.0.0.1:8000/**. This is the React layout with the same Python forecasting application used by Streamlit. The page, API, downloads, and model execution all use this one port. Streamlit does not need to run.

## Start it

From the repository root, with Python 3.11 and Node.js 22.12+ installed:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cd frontend
npm ci
npm run build
cd ..
python -m wind_forecast.agent.dashboard --port 8000
```

In the current local workspace, the prepared environment is `.venv311`, so use `.venv311/bin/python -m wind_forecast.agent.dashboard --port 8000`.

The server reads `examples/local_request.json` for default measurement paths. Put the original CSVs at `data/raw/turbine_1.csv` and `data/raw/turbine_2.csv`, or upload them in Forecast studio. They are not included in Git. Uploaded files are local server snapshots, not an ongoing SCADA feed.

## Generate a forecast

1. Choose **Your measurements** in Forecast studio, or use the clearly labeled synthetic demo to explore without files or network access.
2. Choose **Gradient Boosting** or **CatBoost**. Gradient learns from historical power and weather measurements and retrieves eligible NOAA forecast weather. CatBoost uses the saved power model and ExtraTrees wind model with both turbine histories, without online weather.
3. Select 24 or 48 hours and the turbines. For the supplied historical case, use **1 February 2026**. CatBoost requires **01:00 UTC** (06:00 at the sites), which the form selects automatically. Gradient accepts other hourly issue times, including the 00:00 UTC example.
4. Use the detected project CSVs or upload replacements. Review the CSV timezone, interval convention, and reporting delay, then acknowledge those assumptions. The suggested UTC+5/start/zero-delay settings are operator choices.
5. For Gradient, keep NOAA weather selected or upload a compatible original `weather.json` bundle. Optional settings offer OpenAI workflow coordination and Jev review. Their credentials are read only by the Python server.
6. Click **Generate forecast**. Progress and any errors appear in the studio. The first NOAA request may take a few minutes; downloaded fields are cached.

CatBoost uses both histories even if only one turbine is selected for output. The demo uses a baseline and synthetic weather; it is not presented as CatBoost or Gradient model evidence.

## Read and export the result

The studio shows the full requested horizon, power and wind charts, summary values, hourly rows, source/model information, warnings, and workflow details. Forecast timestamps identify the **end** of each hourly interval in UTC. The power unit is normalized power; it is not MW. The CSV and report ZIP belong to that exact completed run.

The **Site explorer** below retains the original dashboard's map, turbine selection, daily charts, and comparison CSV export. When a run completes, this section uses the same run and selects its issue day. Change the comparison date to inspect subsequent days. These charts use **interval starts in UTC+5**, so their labels differ from the studio's UTC hour-end labels while referring to the same hours.

The supplied CSVs stop on January 31, 2026. A February forecast can therefore have predictions while actual values are empty. Actual-versus-predicted energy comparisons use only hours with both values; an empty comparison is not zero production. The full forecast remains visible above.

Unknown turbine status, wind direction, precipitation events, or icing are not invented. Jev's optional next-three-hours assessment is advisory and does not replace numerical power predictions. CatBoost's offline route does not invoke Jev or OpenAI.

## Keep results current

Automatic monitoring checks for changed source files, eligible weather releases, and model inputs. Successful recalculations replace the displayed forecast version; a failed update leaves the last successful forecast available and reports the failure. Uploads remain snapshots: update the original server files or submit new uploads to provide new measurements. Live Gradient mode needs an appropriate current measurement source; old records are not relabeled as current.

The server must remain running. For an independent persistent worker, the existing `scripts/watch_forecast.py` workflow is still available; see [autonomous_agent.md](autonomous_agent.md).

## Teammate integration

Both websites call `wind_forecast.agent.application.run_forecast` with `RunConfig`. ML teammates continue to supply models and metadata through the existing Python interfaces. The UI does not implement a second prediction model. Weather teammates continue to supply eligible `WeatherBundle` data or the documented JSON bundle.

The dashboard API starts a background job, returns progress and a completed result, and projects that job's output into `/api/dashboard`. The browser never receives an API key. All forecast artifacts remain under `runs/`; existing model, observation-availability, and weather-provenance checks still apply.

Rebuild `frontend/dist` after React edits and restart the Python process after server edits. Refresh the page after both. The standalone Vite/nginx demo and optional Streamlit UI remain available for development, but the unified workflow needs only port 8000.

## Integration checks

Checked locally on 23 September 2026 with Python 3.11:

- React production build and TypeScript compilation passed; modified frontend files pass formatting checks.
- 42 frontend data/transport checks and 7 Python dashboard/job checks passed.
- The unified page completed a real CatBoost 24-hour run: 48 rows for two turbines, with a working wind chart and CSV download.
- The unified page completed a real Gradient Boosting 48-hour NOAA run: 96 rows, with the same model and issue in the site explorer, an hourly table, and a full report download.
- Input refresh, monitoring enable/pause, saved-run restoration, turbine/day selection, and desktop/mobile layouts were checked. At a 390-pixel viewport, the form and results had no page-level horizontal overflow.

These checks establish application execution and integration. They do not establish future forecast accuracy. Optional paid OpenAI/Jev calls were not repeated during this integration check.
