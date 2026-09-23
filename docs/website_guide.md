# Using the alternative Streamlit interface

The main unified website runs on **port 8000**. See [its guide](unified_website.md) for the React forecast studio, map, and charts. This page describes the optional Streamlit interface on port 8501.

The page has two sections: **Set up your forecast** and **Read your forecast**.
Choose inputs, click one button, and see a chart and downloads below. Automatic
updates can keep a real forecast current while the page is open.

## Try it immediately

Leave **Demo data** selected and click **Run demo forecast**. The default produces
24 hourly predictions for each of two turbines. Change **Predict next** to
48 hours for a longer horizon. Demo data is simulated and is labeled throughout.
No upload, API key, or internet is required after installation.

## Use actual measurements

1. Select **Your measurements**.
2. Open **Measurement files**. Upload the organizer's turbine 1 CSV into
   **Turbine 1** and turbine 2 CSV into **Turbine 2**. If project copies exist,
   the page uses them automatically; an upload replaces the corresponding copy
   for this run. The saved local models need both files even if you display only
   one turbine; the weather-driven model needs files for the selected turbines.
3. In **Choose how to predict**, pick one of two options. **Gradient boosting ML**
   is selected initially; choose **NOAA archive (automatic)** to use online weather.
   **CatBoost (saved, offline)** uses saved CatBoost power and ExtraTrees wind
   models with both turbine CSVs and no internet weather. It requires the
   `[app,local]` dependencies. The controls appear above **Optional settings**. A complete uploaded
   `weather.json` is an offline alternative for Gradient boosting.
4. Under **Forecast timing**, choose **Historical date** for a past issue, then
   set **Forecast date (UTC)** and **Time (UTC)**. CatBoost automatically sets
   the required **01:00 UTC** (06:00 UTC+5); choose **February 1, 2026** for
   the supplied case. The weather-driven example uses **00:00 UTC**. The
   **Latest available (live)** option is offered for Gradient boosting when
   fresh measurements are supplied.
5. Choose **24 or 48 hours** and the turbines.
6. Check the CSV timestamp assumptions shown above the button. Adjust them in
   **Optional settings** and tick **Use these timestamp assumptions**. UTC+5,
   interval starts, and zero delay are the page's initial choices, not
   organizer-confirmed facts. Changing them requires acknowledging them again.
7. To refresh automatically, tick **Keep forecast updated automatically**.
8. Click **Generate forecast** and wait for the selected model's prediction.

On the NOAA route, the first weather retrieval may take several minutes. The app
keeps a local cache to reduce later downloads. It checks recent GFS cycles and
selects the newest complete version available by the issue time, then retrieves
wind and temperature by the turbine coordinates. Historical mode uses original
past forecast files. It never substitutes fabricated
weather when real weather is unavailable. If a run fails, the page explains the
reason and provides its report when the application created one.

The saved CatBoost power and ExtraTrees wind models use local history and do not
fetch weather. The separate **Gradient boosting ML** route learns from eligible wind,
temperature, calendar features and measured power, using NOAA or an uploaded
weather bundle. The demo uses the empirical baseline. All run on the CPU without
a GPU or an AI API key. See the [weather sources](weather_sources.md) and
[model explanation](model_ml.md).

## Keep the forecast updated

Tick **Keep forecast updated automatically** before clicking **Generate forecast**.
The agent checks every five minutes for changed measurement files, model
artifacts and eligible weather. A change triggers the complete workflow again;
the chart and downloadable result update when it succeeds. The status shows the
latest trigger and next check time. Unchanged inputs do not retrain or call OpenAI.

In **Historical date**, the issue stays fixed and later weather is ineligible.
In **Latest available (live)**, each new UTC hour advances the forecast window
on the next due check. Live uses observations available at that issue. The supplied
historical CSVs can train the model, but they provide no fresh operating feed;
the analysis reports the age of the most recent eligible measurement.

To feed new measurements automatically, update `data/raw/turbine_1.csv` and
`data/raw/turbine_2.csv` on the host. A browser upload is a single snapshot.
Unchecking automatic updates stops this page's monitoring. Changing request
controls also stops its previous monitor; click **Generate forecast** to start
the new request. A failed automatic update keeps the last successful forecast
visible, reports the problem, and retries at the next check.

Keep the page open for webpage updates. For a process that runs independently of
the browser, save a request JSON and use:

```bash
python scripts/watch_forecast.py --config my_real_request.json \
  --state-dir runs/monitor-service --interval-seconds 300
```

Add `--live` for a config with `mode: "live"`. Keep the CLI process running;
Ctrl+C stops it and retains saved state. The [autonomous agent guide](autonomous_agent.md)
includes an offline example, `--once`, `--max-cycles`, and recovery details.

## Understand the results

The forecast appears in **Read your forecast**, immediately below the controls.
The issue time and horizon printed above the chart identify the saved run.

**Summary cards** show the average predicted normalized power of each turbine
across the selected horizon, its peak, and the UTC hour ending at that peak.
These describe predictions; they are not accuracy measurements.

**The chart** uses blue for Turbine 1 and orange for Turbine 2. Different line
styles help distinguish overlapping predictions. Hover over a point to see the
predicted hourly interval and exact value. Both turbines share the same vertical
scale. Values outside the usual source range are kept visible rather than
clipped. A shaded 10th–90th percentile band appears only when the model supplies
those quantiles.

The horizontal axis is **UTC hour ending**. For example, a point at February 1,
01:00 predicts the interval from 00:00 to 01:00. The vertical axis is **normalized
active power**, in the units of the supplied CSV. Higher values mean greater
output. Conversion to MW requires the normalization definition and capacity.

Open **View hourly values** to see a compact table with one column per turbine.
There are 24 or 48 rows; a two-turbine CSV has 48 or 96 records because each
record represents one turbine and one hour.

Open **Forecast analysis and model validation** to review peaks, large changes,
old measurements and weather outside the training range. Its chronological ML
validation table compares gradient boosting and the empirical baseline using
held-out **measured wind and temperature**. These errors describe regression
quality; actual 24–48-hour forecast accuracy also depends on weather forecast
errors and needs a separate historical replay with target measurements.

For an immediate operational review, open **Optional settings** and enable
**Jev: review the next 3 hours** before generating a weather-driven real forecast. The saved local-model route does not invoke Jev. Set `TYPESAFE_API_KEY` in the server environment or ignored `.env`, or supply a project-root `typesafe.env` as a fallback. You can add an **Operator note** in English or
Russian, select its turbines and declare when it became available and expires.
Notes must have been known by the forecast issue time. Leave the field blank
to review just the available measurement and forecast context.

Read **Jev · Next 3 hours** under the result analysis: each turbine gets a
reported condition and suggested review step. Expand **Review evidence and
probabilities** for its inputs. Uncertain judgments and stale measurements stay
visible. These are advisory judgments about supplied evidence, not failure-rate
or power predictions. Jev also runs on automatic forecast updates. An edited web
note needs **Generate forecast** again; background note feeds are described in
the [Jev guide](jev_operations.md). This feature works without OpenAI.

Changing request controls leaves the previous forecast visible with a notice.
Click **Generate forecast** to calculate the new request. Automatic updates also
refresh results after files or weather change. Each run is saved as a separate
version.

## Download and inspect

- **Download forecast CSV** saves the numerical output, including issue time,
  valid time, turbine ID, lead, prediction, and any model quantiles.
- **Download full report (ZIP)** saves the forecast and its request, report,
  model identity, summary, workflow trace, and weather evidence when used.
- **How this forecast was made** shows a short explanation of the model,
  eligible measurements, source availability, data preparation, and limitations.
  The weather-driven trace shows weather, preparation, training, input checks,
  prediction, analysis and saving; the saved local-model trace records its own
  preparation, model loading and prediction stages.
- **AI explanation** appears when optional OpenAI orchestration completes.

All run files are also saved under `runs/application/`. If actual targets exist
for a historical forecast window, diagnostic accuracy appears inside the details.
The supplied CSVs contain no February targets, so February forecasts cannot yet
be scored. Demo metrics, if available, are synthetic diagnostics only.

## Optional settings

Most reviewers can leave this panel closed after reviewing the timestamp assumptions.

| Setting | When to change it |
|---|---|
| CSV timezone, interval label, reporting delay | Match the organizer's export and measurement availability |
| Forecast wind height | Match the weather feature used by the numerical model |
| Measurement history | Permit later observations only when they genuinely existed at the issue time |
| Use OpenAI agent | Request API orchestration and an explanation when the host has configured credentials |
| Jev: review the next 3 hours | Interpret operational notes and forecast context; requires a TypeSafe key |

The host configures teammate artifacts and the optional `OPENAI_API_KEY` in
local `.env` or environment variables. `OPENAI_MODEL` optionally overrides the
application default `gpt-4.1-mini`. Keys are never entered into request files or
committed to Git. **Use OpenAI agent** is available when a key is present. The local
controller makes no OpenAI calls; automatic weather retrieval still needs
internet. A matching local weather JSON allows an offline real-data run.
The numerical model always calculates the power values.
The main form offers exactly two models. The empirical baseline and teammate
model adapter remain available through Python/CLI configuration.
The full report ZIP also includes `operations.json` when Jev is enabled. Its
inputs and decisions remain inspectable even when Jev cannot complete a review.

Batch replay, custom Python providers and the full configuration contract are
in the [Python/CLI guide](application_io.md). For setup commands, see the
[README](../README.md).
