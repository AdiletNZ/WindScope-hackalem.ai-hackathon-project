import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CloudSun,
  Download,
  FileCheck2,
  FileUp,
  Info,
  LoaderCircle,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Wind,
  Zap,
} from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  createForecast,
  loadForecast,
  loadForecastOptions,
  refreshForecast,
  setForecastMonitor,
  type ForecastInput,
  type ForecastJob,
  type ForecastModel,
  type ForecastOptions,
  type ForecastOutput,
  type TurbineId,
} from './forecastApi';
import './forecast.css';

const TURBINES: TurbineId[] = ['T1', 'T2'];
const COLORS = { T1: '#23745b', T2: '#b28643' };
const LAST_JOB = 'windscope.forecast.job';
const utc = (value: string, full = false) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    ...(full ? { day: '2-digit', month: 'short', year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
const fixed = (value: number | null | undefined, digits = 3) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The forecast could not start. Please try again.';
const labels: Record<string, string> = {
  queued: 'Waiting to start',
  fetch_weather: 'Retrieving eligible weather',
  prepare_data: 'Preparing measurement history',
  train_model: 'Preparing the prediction model',
  audit_inputs: 'Checking times and data coverage',
  predict_power: 'Predicting hourly power',
  inspect_forecast: 'Analysing forecast results',
  save_forecast: 'Saving your forecast',
  completed: 'Forecast ready',
};

function ForecastResults({ result }: { result: ForecastOutput }) {
  const [metric, setMetric] = useState<'power' | 'wind'>('power');
  const turbines = TURBINES.filter((id) => result.rows.some((row) => row.turbine_id === id));
  const hasWind = result.rows.some((row) => typeof row.wind_ms === 'number');
  const selectedMetric = hasWind ? metric : 'power';
  const chartData = useMemo(() => {
    const grouped = new Map<string, Record<string, string | number | number[] | null>>();
    for (const row of result.rows) {
      const point = grouped.get(row.valid_time) ?? { time: row.valid_time };
      point[`${row.turbine_id}_power`] = row.prediction;
      point[`${row.turbine_id}_wind`] = row.wind_ms;
      if (typeof row.p10 === 'number' && typeof row.p90 === 'number')
        point[`${row.turbine_id}_band`] = [row.p10, row.p90];
      grouped.set(row.valid_time, point);
    }
    return [...grouped.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  }, [result.rows]);
  const weather = object(result.report.weather);
  const weatherProvider =
    typeof weather.provider === 'string' && weather.provider !== 'none' ? weather.provider : '';
  const controller = object(result.report.controller);
  const findings = object(result.report.forecast).findings;
  const operations = result.operations;
  const hasBands =
    selectedMetric === 'power' && result.rows.some((row) => typeof row.p10 === 'number');
  const first = chartData[0]?.time;
  const last = chartData.at(-1)?.time;
  const validation = object(result.report.model_validation);
  const validationRows = Object.entries(object(validation.by_turbine)).flatMap(
    ([turbine, value]) => {
      const metrics = object(object(value).validation);
      return Object.entries(metrics)
        .filter(([name]) => ['ml', 'empirical_baseline'].includes(name))
        .map(([name, details]) => ({ turbine, name, details: object(details) }));
    },
  );
  return (
    <section className="fw-results" id="forecast-results" aria-labelledby="forecast-result-title">
      <div className="fw-result-heading">
        <div>
          <div className="fw-kicker">
            <CheckCircle2 size={15} /> FORECAST READY
          </div>
          <h2 id="forecast-result-title">Your next {result.horizon_hours} hours</h2>
          <p>
            Issued {utc(result.issue_time, true)} UTC · {result.rows.length} hourly predictions
          </p>
        </div>
        <div className="fw-downloads">
          <a href={result.downloads.csv} download>
            <Download size={15} /> Forecast CSV
          </a>
          <a href={result.downloads.zip} download>
            <Download size={15} /> Full report
          </a>
        </div>
      </div>
      {result.is_synthetic && (
        <div className="fw-notice">
          <Info size={17} />
          <span>
            <strong>Synthetic demonstration.</strong> Measurements, weather and predictions are
            simulated for this run.
          </span>
        </div>
      )}
      <div className="fw-result-metrics">
        {turbines.map((id) => {
          const rows = result.rows.filter((row) => row.turbine_id === id);
          const mean = rows.reduce((sum, row) => sum + row.prediction, 0) / rows.length;
          const peak = rows.reduce((best, row) => (row.prediction > best.prediction ? row : best));
          return (
            <article className="fw-output-card" key={id}>
              <span className="fw-metric-label">
                <i style={{ background: COLORS[id] }} /> Turbine {id.slice(1)} · mean forecast power
              </span>
              <strong>
                {fixed(mean)}
                <small>n.u.</small>
              </strong>
              <p>
                Peak <b>{fixed(peak.prediction)}</b> · {utc(peak.valid_time, true)} UTC
              </p>
            </article>
          );
        })}
        <article className="fw-output-card fw-output-source">
          <span className="fw-metric-label">
            <CloudSun size={15} /> Forecast source
          </span>
          <strong>
            {result.is_synthetic
              ? 'Demo inputs'
              : weatherProvider
                ? 'Weather + history'
                : 'Measurement history'}
          </strong>
          <p>
            {result.is_synthetic
              ? 'Offline empirical baseline'
              : weatherProvider || 'Saved CatBoost power · ExtraTrees wind'}
          </p>
        </article>
      </div>
      <div className="fw-chart-card">
        <div className="fw-chart-toolbar">
          <div role="group" aria-label="Forecast chart measurement" className="fw-segment">
            <button
              type="button"
              aria-pressed={selectedMetric === 'power'}
              onClick={() => setMetric('power')}
            >
              <Zap size={14} /> Power
            </button>
            {hasWind && (
              <button
                type="button"
                aria-pressed={selectedMetric === 'wind'}
                onClick={() => setMetric('wind')}
              >
                <Wind size={15} /> Wind speed
              </button>
            )}
          </div>
          <div className="fw-chart-legend">
            {turbines.map((id) => (
              <span key={id}>
                <i style={{ background: COLORS[id] }} /> Turbine {id.slice(1)}
              </span>
            ))}
          </div>
        </div>
        <div className="fw-chart-axis">
          {selectedMetric === 'power' ? 'Normalized power · n.u.' : 'Wind speed · m/s'}
        </div>
        <div
          className="fw-chart"
          role="img"
          aria-label={`Hourly ${selectedMetric} forecast for ${result.horizon_hours} hours. Exact values are available in the hourly table below.`}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <ComposedChart
              data={chartData}
              margin={{ top: 12, right: 20, bottom: 4, left: -15 }}
              accessibilityLayer
            >
              <CartesianGrid stroke="#e7ece5" vertical={false} strokeDasharray="3 5" />
              <XAxis
                dataKey="time"
                tickFormatter={(value) => utc(String(value))}
                minTickGap={40}
                tickLine={false}
                axisLine={false}
                tickMargin={12}
                fontSize={11}
                stroke="#66756b"
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                fontSize={11}
                stroke="#66756b"
                domain={[(min: number) => Math.min(0, min), 'auto']}
                tickFormatter={(value) => Number(value).toFixed(selectedMetric === 'power' ? 2 : 1)}
              />
              <Tooltip
                labelFormatter={(value) => `Hour ending ${utc(String(value), true)} UTC`}
                formatter={(value, name) => [
                  `${fixed(typeof value === 'number' ? value : null)} ${selectedMetric === 'power' ? 'n.u.' : 'm/s'}`,
                  `Turbine ${String(name).charAt(1)}`,
                ]}
                contentStyle={{
                  border: '1px solid #dce5da',
                  borderRadius: 12,
                  fontSize: 12,
                  boxShadow: '0 8px 30px #173e3210',
                }}
              />
              {hasBands &&
                turbines.map((id) => (
                  <Area
                    key={`${id}_band`}
                    type="linear"
                    dataKey={`${id}_band`}
                    stroke="none"
                    fill={COLORS[id]}
                    fillOpacity={0.08}
                    legendType="none"
                    tooltipType="none"
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                ))}
              {turbines.map((id) => (
                <Line
                  key={id}
                  type="linear"
                  dataKey={`${id}_${selectedMetric}`}
                  name={id}
                  stroke={COLORS[id]}
                  strokeWidth={2.6}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="fw-chart-footer">
          <span>
            {first && last ? `${utc(String(first), true)} – ${utc(String(last), true)} UTC` : ''}
          </span>
          <span>Each point is the hour ending at the displayed time.</span>
        </div>
      </div>
      <p className="fw-unit-note">
        Power uses the dataset’s normalized units, not MW.{' '}
        {hasBands ? 'Shading shows the model’s 10th–90th percentile range. ' : ''}Missing
        observations are never filled with zero.
      </p>
      {result.warnings.length > 0 && (
        <details className="fw-details fw-result-warning">
          <summary>
            <TriangleAlert size={16} />
            <span>
              {result.warnings.length} forecast {result.warnings.length === 1 ? 'note' : 'notes'} to
              review
            </span>
            <ChevronDown size={16} />
          </summary>
          <ul>
            {result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {operations && (
        <section className="fw-jev-result" aria-label="Jev operational review">
          <div className="fw-jev-title">
            <span>
              <Sparkles size={17} /> Jev · next 3 hours
            </span>
            <small>Operational guidance</small>
          </div>
          {operations.state === 'completed' && operations.by_turbine ? (
            <div className="fw-jev-grid">
              {Object.entries(operations.by_turbine).map(([id, advisory]) => (
                <article key={id}>
                  <h3>
                    Turbine {id.slice(1)} · {advisory.condition_label}
                  </h3>
                  <p>{advisory.recommendation}</p>
                  {advisory.computed_flags.map((flag, index) => (
                    <p className="fw-small" key={index}>
                      {flag}
                    </p>
                  ))}
                  {advisory.uncertain && (
                    <p className="fw-small">
                      Jev’s interpretation is uncertain. Check the evidence before acting.
                    </p>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p>{operations.message ?? 'The operational review is unavailable for this run.'}</p>
          )}
          <p className="fw-small">
            Advisory review of supplied evidence. Hourly power values come from the forecasting
            model.
          </p>
        </section>
      )}
      <details className="fw-details">
        <summary>
          <Activity size={16} />
          <span>Hourly values</span>
          <small>{result.rows.length} rows</small>
          <ChevronDown size={16} />
        </summary>
        <div
          className="fw-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Hourly forecast values"
        >
          <table>
            <caption>
              Forecast hours are UTC interval ends. Power is normalized; wind is in m/s.
            </caption>
            <thead>
              <tr>
                <th>Hour ending (UTC)</th>
                <th>Turbine</th>
                <th>Power · n.u.</th>
                <th>Wind · m/s</th>
                <th>Temperature · °C</th>
                <th>P10–P90 · n.u.</th>
              </tr>
            </thead>
            <tbody>
              {[...result.rows]
                .sort(
                  (a, b) =>
                    a.valid_time.localeCompare(b.valid_time) ||
                    a.turbine_id.localeCompare(b.turbine_id),
                )
                .map((row) => (
                  <tr key={`${row.turbine_id}-${row.valid_time}`}>
                    <td>{utc(row.valid_time, true)}</td>
                    <td>{row.turbine_id}</td>
                    <td>{fixed(row.prediction)}</td>
                    <td>{fixed(row.wind_ms, 2)}</td>
                    <td>{fixed(row.temp_c, 1)}</td>
                    <td>
                      {row.p10 == null || row.p90 == null
                        ? '—'
                        : `${fixed(row.p10)}–${fixed(row.p90)}`}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className="fw-details">
        <summary>
          <ShieldCheck size={16} />
          <span>Analysis, sources & workflow</span>
          <ChevronDown size={16} />
        </summary>
        <div className="fw-analysis">
          <dl>
            <div>
              <dt>Power model</dt>
              <dd>{result.model_id}</dd>
            </div>
            <div>
              <dt>Weather</dt>
              <dd>
                {weatherProvider ||
                  (result.is_synthetic
                    ? 'Synthetic demonstration'
                    : 'No external weather · saved local models')}
              </dd>
            </div>
            <div>
              <dt>Forecast status</dt>
              <dd>{result.status === 'ok' ? 'Numerical checks passed' : result.status}</dd>
            </div>
            <div>
              <dt>Run</dt>
              <dd>{result.run_id}</dd>
            </div>
          </dl>
          {Array.isArray(findings) && findings.length > 0 && (
            <ul>
              {findings.map((item, index) => (
                <li key={index}>{String(item)}</li>
              ))}
            </ul>
          )}
          {validationRows.length > 0 && (
            <>
              <h3>Model validation</h3>
              <p className="fw-small">
                Chronological holdout using measured weather. This checks the regression model; it
                does not measure accuracy of future weather forecasts.
              </p>
              <div className="fw-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Turbine</th>
                      <th>Model</th>
                      <th>MAE</th>
                      <th>RMSE</th>
                      <th>Bias</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validationRows.map((row) => (
                      <tr key={`${row.turbine}-${row.name}`}>
                        <td>{row.turbine}</td>
                        <td>{row.name === 'ml' ? 'Gradient boosting' : 'Empirical baseline'}</td>
                        <td>{fixed(Number(row.details.mae))}</td>
                        <td>{fixed(Number(row.details.rmse))}</td>
                        <td>{fixed(Number(row.details.bias))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {object(result.report.evaluation).state === 'no_ground_truth' && (
            <p className="fw-small">
              Accuracy for this forecast window is unavailable because measured target values have
              not been supplied.
            </p>
          )}
          {result.summary && (
            <>
              <h3>
                {String(controller.used ?? '').startsWith('openai')
                  ? 'Controller explanation'
                  : 'Run summary'}
              </h3>
              <p className="fw-plain-text">{result.summary}</p>
            </>
          )}
          {result.trace.length > 0 && (
            <ol className="fw-trace">
              {result.trace
                .filter((event) => event.step && event.status !== 'started')
                .map((event, index) => (
                  <li key={index}>
                    <span>{String(event.step).replaceAll('_', ' ')}</span>
                    <small>{event.status}</small>
                  </li>
                ))}
            </ol>
          )}
          {String(weather.provider ?? '').startsWith('NOAA') && (
            <a
              className="fw-source-link"
              href="https://registry.opendata.aws/noaa-gfs-bdp-pds/"
              target="_blank"
              rel="noreferrer"
            >
              NOAA GFS public forecast archive ↗
            </a>
          )}
        </div>
      </details>
    </section>
  );
}

export default function ForecastWorkspace({
  onRunComplete,
}: {
  onRunComplete?: (runId: string, issueTime: string) => void;
}) {
  const [options, setOptions] = useState<ForecastOptions | null>(null);
  const [optionsError, setOptionsError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [dataMode, setDataMode] = useState<'real' | 'demo'>('real');
  const [model, setModel] = useState<ForecastModel>('gradient_boosting');
  const [timing, setTiming] = useState<'historical' | 'live'>('historical');
  const [date, setDate] = useState('2026-02-01');
  const [hour, setHour] = useState(0);
  const [horizon, setHorizon] = useState<24 | 48>(24);
  const [turbines, setTurbines] = useState<TurbineId[]>(['T1', 'T2']);
  const [uploads, setUploads] = useState<Partial<Record<TurbineId, File>>>({});
  const [weatherSource, setWeatherSource] = useState<'noaa_gfs' | 'bundles'>('noaa_gfs');
  const [weatherFile, setWeatherFile] = useState<File | null>(null);
  const [zone, setZone] = useState('Etc/GMT-5');
  const [interval, setIntervalLabel] = useState<'start' | 'end'>('start');
  const [delay, setDelay] = useState(0);
  const [policy, setPolicy] = useState<'available' | 'frozen_jan31'>('available');
  const [confirmed, setConfirmed] = useState(false);
  const [openai, setOpenai] = useState(false);
  const [jev, setJev] = useState(false);
  const [note, setNote] = useState('');
  const [noteTurbines, setNoteTurbines] = useState<TurbineId[]>(['T1', 'T2']);
  const [noteAvailable, setNoteAvailable] = useState('2026-02-01T00:00');
  const [noteUntil, setNoteUntil] = useState('2026-02-01T03:00');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [job, setJob] = useState<ForecastJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [submittedSignature, setSubmittedSignature] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const callback = useRef(onRunComplete);
  callback.current = onRunComplete;
  const lastNotified = useRef('');
  const monitorPause = useRef('');
  const resultRef = useRef<HTMLDivElement>(null);
  const real = dataMode === 'real';
  const local = real && model === 'local_history';
  const busy = submitting || job?.state === 'queued' || job?.state === 'running';
  const requiredInputs = local ? TURBINES : turbines;
  const signature = JSON.stringify({
    dataMode,
    model,
    timing,
    date,
    hour,
    horizon,
    turbines,
    uploads: Object.entries(uploads).map(([id, file]) => [
      id,
      file?.name,
      file?.size,
      file?.lastModified,
    ]),
    weatherSource,
    weatherFile: weatherFile && [weatherFile.name, weatherFile.size, weatherFile.lastModified],
    zone,
    interval,
    delay,
    policy,
    confirmed,
    openai,
    jev,
    note,
    noteTurbines,
    noteAvailable,
    noteUntil,
  });
  const stale = submittedSignature !== null && submittedSignature !== signature;

  useEffect(() => {
    const controller = new AbortController();
    setOptionsError('');
    loadForecastOptions(controller.signal)
      .then((value) => {
        setOptions(value);
        setDate(value.defaults.issue_time.slice(0, 10));
        setZone(value.defaults.source_timezone);
        setIntervalLabel(value.defaults.interval_label);
        setDelay(value.defaults.reporting_delay_minutes);
        setPolicy(value.defaults.observation_policy);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setOptionsError(message(failure));
      });
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    let id: string | null = null;
    try {
      id = sessionStorage.getItem(LAST_JOB);
    } catch {
      /* Private browsing can disable storage. */
    }
    if (id)
      loadForecast(id, controller.signal)
        .then((value) => {
          setJob(value);
          setRestored(true);
          setAutoRefresh(value.monitor.enabled);
        })
        .catch(() => {
          try {
            sessionStorage.removeItem(LAST_JOB);
          } catch {
            /* No storage. */
          }
        });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!job || (!['queued', 'running'].includes(job.state) && !job.monitor.enabled)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        loadForecast(job.id, controller.signal)
          .then((value) => {
            setJob(value);
            setPollError('');
          })
          .catch((failure) => {
            if (!controller.signal.aborted) {
              setPollError(message(failure));
              setJob((current) => (current ? { ...current } : current));
            }
          });
      },
      ['queued', 'running'].includes(job.state) ? 1500 : 15000,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [job]);

  useEffect(() => {
    if (job?.result && lastNotified.current !== job.result.run_id) {
      lastNotified.current = job.result.run_id;
      callback.current?.(job.result.run_id, job.result.issue_time);
    }
  }, [job]);

  useEffect(() => {
    if (restored && options && submittedSignature === null) setSubmittedSignature(signature);
  }, [restored, options, submittedSignature, signature]);

  useEffect(() => {
    if (!stale || !job?.monitor.enabled || busy) return;
    const pauseKey = `${job.id}:${signature}`;
    if (monitorPause.current === pauseKey) return;
    monitorPause.current = pauseKey;
    setForecastMonitor(job.id, false)
      .then((value) => {
        setJob((current) => (current?.id === value.id ? value : current));
        setAutoRefresh(false);
      })
      .catch((failure) => setError(`Could not pause automatic updates: ${message(failure)}`));
  }, [stale, job?.id, job?.monitor.enabled, busy, signature]);

  function chooseModel(value: ForecastModel) {
    setModel(value);
    if (value === 'local_history') {
      setHour(1);
      setTiming('historical');
      setZone('Etc/GMT-5');
      setIntervalLabel('start');
      setConfirmed(false);
    }
  }

  function toggleTurbine(id: TurbineId) {
    setTurbines((current) =>
      current.includes(id)
        ? current.length > 1
          ? current.filter((item) => item !== id)
          : current
        : TURBINES.filter((item) => item === id || current.includes(item)),
    );
  }

  const problem = !options
    ? 'Waiting for the forecast service.'
    : real && !options.models.find((item) => item.id === model)?.available
      ? options.models.find((item) => item.id === model)?.reason ||
        'This model is unavailable in the server environment.'
      : real && requiredInputs.some((id) => !uploads[id] && !options.measurements[id]?.available)
        ? 'Add the measurement CSVs below to start this forecast.'
        : real && !confirmed
          ? 'Confirm the measurement timestamp assumptions below.'
          : real && !local && weatherSource === 'bundles' && !weatherFile
            ? 'Upload a weather.json forecast bundle.'
            : real && timing === 'historical' && !date
              ? 'Choose a forecast issue date.'
              : '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (problem || busy) return;
    setSubmitting(true);
    setError('');
    setPollError('');
    try {
      if (job?.monitor.enabled) setJob(await setForecastMonitor(job.id, false));
      const issue =
        real && timing === 'live'
          ? new Date(new Date().setUTCMinutes(0, 0, 0)).toISOString()
          : new Date(`${date}T${String(local ? 1 : hour).padStart(2, '0')}:00:00Z`).toISOString();
      const files: ForecastInput['uploads'] = {};
      if (real)
        for (const id of requiredInputs) {
          const file = uploads[id];
          if (file) {
            if (file.size > 25 * 1024 * 1024)
              throw new Error(`${file.name} exceeds the 25 MB measurement-file limit.`);
            files[id] = { name: file.name, content: await file.text() };
          }
        }
      if (
        real &&
        !local &&
        weatherSource === 'bundles' &&
        weatherFile &&
        weatherFile.size > 25 * 1024 * 1024
      )
        throw new Error('The weather bundle exceeds 25 MB. Choose a single weather.json export.');
      const input: ForecastInput = {
        mode: real ? timing : 'fixture',
        model_kind: model,
        issue_time: issue,
        horizon_hours: horizon,
        turbine_ids: turbines,
        source_timezone: zone,
        interval_label: interval,
        reporting_delay_minutes: delay,
        assumptions_confirmed: real && confirmed,
        observation_policy: policy,
        weather_source: weatherSource,
        uploads: files,
        controller: real && !local && openai ? 'openai' : 'deterministic',
        jev_enabled: real && !local && jev,
        auto_refresh: real && autoRefresh,
      };
      if (real && !local && weatherSource === 'bundles' && weatherFile)
        input.weather_upload = { name: weatherFile.name, content: await weatherFile.text() };
      if (input.jev_enabled && note.trim()) {
        const available = new Date(`${noteAvailable}Z`);
        const until = new Date(`${noteUntil}Z`);
        if (
          !noteTurbines.length ||
          !Number.isFinite(available.getTime()) ||
          !Number.isFinite(until.getTime()) ||
          available > new Date(issue) ||
          until <= new Date(issue)
        )
          throw new Error(
            'For Jev, choose note turbines and UTC times: available by the forecast issue, expiring after it.',
          );
        input.operational_notes = [
          {
            text: note.trim(),
            turbine_ids: noteTurbines,
            available_at: available.toISOString(),
            valid_until: until.toISOString(),
          },
        ];
      }
      const started = await createForecast(input);
      setJob(started);
      setSubmittedSignature(signature);
      setRestored(false);
      try {
        sessionStorage.setItem(LAST_JOB, started.id);
      } catch {
        /* Forecasting also works without storage. */
      }
    } catch (failure) {
      setError(message(failure));
    } finally {
      setSubmitting(false);
    }
  }

  async function updateMonitor(enabled: boolean) {
    if (!job) return;
    setError('');
    try {
      setJob(await setForecastMonitor(job.id, enabled));
      setAutoRefresh(enabled);
    } catch (failure) {
      setError(message(failure));
    }
  }

  async function refresh() {
    if (!job) return;
    setSubmitting(true);
    setError('');
    try {
      setJob(await refreshForecast(job.id));
    } catch (failure) {
      setError(message(failure));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className="forecast-workspace"
      id="forecast"
      aria-labelledby="forecast-workspace-title"
    >
      <div className="fw-heading">
        <div>
          <span className="fw-kicker">
            <Wind size={16} /> FORECAST STUDIO
          </span>
          <h2 id="forecast-workspace-title">Turn wind into a clearer plan.</h2>
          <p>
            Choose your model. We prepare the data, run the forecast and explain the next {horizon}{' '}
            hours.
          </p>
        </div>
        <span className="fw-header-badge">
          <span className="status-dot" /> One connected workflow
        </span>
      </div>
      {optionsError ? (
        <div className="fw-notice fw-error" role="alert">
          <TriangleAlert size={18} />
          <span>{optionsError}</span>
          <button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : !options ? (
        <div className="fw-notice" role="status">
          <LoaderCircle className="fw-spin" size={18} /> Connecting to your forecasting models…
        </div>
      ) : (
        <form className="fw-form" onSubmit={submit}>
          <div className="fw-input-top">
            <div className="fw-step-heading">
              <span>01</span>
              <div>
                <h3>Set up your forecast</h3>
                <p>Real measurements or a clearly labeled offline demo.</p>
              </div>
            </div>
            <div className="fw-segment" role="group" aria-label="Forecast data source">
              <button
                type="button"
                aria-pressed={real}
                disabled={busy}
                onClick={() => setDataMode('real')}
              >
                Your measurements
              </button>
              <button
                type="button"
                aria-pressed={!real}
                disabled={busy}
                onClick={() => setDataMode('demo')}
              >
                Try demo
              </button>
            </div>
          </div>
          <fieldset className="fw-model-field" disabled={busy}>
            <legend>Prediction model</legend>
            {real ? (
              <div className="fw-model-grid">
                {(['gradient_boosting', 'local_history'] as const).map((id) => {
                  const available = options.models.find((item) => item.id === id);
                  const selected = model === id;
                  return (
                    <label className={`fw-model-card ${selected ? 'is-selected' : ''}`} key={id}>
                      <input
                        type="radio"
                        name="forecast-model"
                        value={id}
                        checked={selected}
                        onChange={() => chooseModel(id)}
                      />
                      <span className="fw-model-icon">
                        {id === 'gradient_boosting' ? (
                          <CloudSun size={23} />
                        ) : (
                          <Activity size={23} />
                        )}
                      </span>
                      <span className="fw-model-copy">
                        <strong>
                          {id === 'gradient_boosting' ? 'Gradient Boosting' : 'CatBoost'}
                        </strong>
                        <span>
                          {id === 'gradient_boosting'
                            ? 'Measurements + forecast weather'
                            : 'Saved model + measurement history'}
                        </span>
                        <small>
                          {!available?.available
                            ? 'Setup required'
                            : id === 'gradient_boosting'
                              ? 'NOAA weather · historical or live'
                              : 'Offline ready · includes wind prediction'}
                        </small>
                      </span>
                      <span className="fw-radio-mark">{selected && <Check size={12} />}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="fw-notice">
                <Info size={18} />
                <span>
                  <strong>Offline demonstration.</strong> Uses synthetic measurements, weather and
                  an empirical baseline. No API calls or credits.
                </span>
              </div>
            )}
          </fieldset>
          <fieldset className="fw-config-field" disabled={busy}>
            <legend className="fw-sr-only">Forecast settings</legend>
            <div className="fw-settings-grid">
              <label className="fw-field">
                <span>Forecast horizon</span>
                <select
                  value={horizon}
                  onChange={(event) => setHorizon(Number(event.target.value) as 24 | 48)}
                >
                  <option value={24}>Next 24 hours</option>
                  <option value={48}>Next 48 hours</option>
                </select>
              </label>
              <div className="fw-field">
                <span id="forecast-turbines-label">Turbines</span>
                <div className="fw-turbines" role="group" aria-labelledby="forecast-turbines-label">
                  {TURBINES.map((id) => (
                    <button
                      type="button"
                      key={id}
                      aria-pressed={turbines.includes(id)}
                      onClick={() => toggleTurbine(id)}
                    >
                      <Wind size={15} /> Turbine {id.slice(1)}
                      {turbines.includes(id) && <Check size={13} />}
                    </button>
                  ))}
                </div>
              </div>
              {real && (
                <label className="fw-field">
                  <span>Forecast timing</span>
                  <select
                    value={local ? 'historical' : timing}
                    disabled={local}
                    onChange={(event) => setTiming(event.target.value as 'historical' | 'live')}
                  >
                    <option value="historical">Historical date</option>
                    {!local && <option value="live">Current time · live</option>}
                  </select>
                </label>
              )}
              {(!real || timing === 'historical' || local) && (
                <label className="fw-field">
                  <span>Issue date · UTC</span>
                  <input
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                    required
                  />
                </label>
              )}
              {(!real || timing === 'historical' || local) && (
                <label className="fw-field fw-hour-field">
                  <span>Issue time · UTC</span>
                  <select
                    value={local ? 1 : hour}
                    disabled={local}
                    onChange={(event) => setHour(Number(event.target.value))}
                  >
                    {Array.from({ length: 24 }, (_, index) => (
                      <option key={index} value={index}>
                        {String(index).padStart(2, '0')}:00
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="fw-context-note">
              <Info size={14} />
              {!real
                ? 'This run is a demonstration, including its charts and downloadable results.'
                : local
                  ? 'CatBoost issues at 01:00 UTC (06:00 UTC+5). Both turbine histories are needed, even when predicting one turbine.'
                  : timing === 'live'
                    ? 'Live forecasts use the current UTC hour. Supply recent measurements; the archived case CSVs do not contain today’s readings.'
                    : 'With the supplied case data, start with 1 February 2026. The first value predicts the hour ending one hour after issue.'}
            </p>
            {real && (
              <>
                <div className="fw-files-heading">
                  <span>Measurement files</span>
                  <small>Use the available server files, or replace them for this run.</small>
                </div>
                <div className="fw-files-grid">
                  {requiredInputs.map((id) => (
                    <div className="fw-file-card" key={id}>
                      <span
                        className={`fw-file-icon ${uploads[id] || options.measurements[id]?.available ? 'ready' : ''}`}
                      >
                        {uploads[id] || options.measurements[id]?.available ? (
                          <FileCheck2 size={21} />
                        ) : (
                          <FileUp size={21} />
                        )}
                      </span>
                      <div>
                        <strong>Turbine {id.slice(1)} CSV</strong>
                        <p>
                          {uploads[id]?.name ??
                            (options.measurements[id]?.available
                              ? options.measurements[id].name
                              : 'No measurement file available')}
                        </p>
                        <small>
                          {uploads[id]
                            ? 'Uploaded file · used for this forecast'
                            : options.measurements[id]?.available
                              ? 'Server file ready'
                              : 'Choose the organizer measurement CSV'}
                        </small>
                      </div>
                      <label className="fw-file-button">
                        {uploads[id] ? 'Replace' : 'Upload'}
                        <input
                          type="file"
                          accept=".csv,text/csv"
                          aria-label={`Upload turbine ${id.slice(1)} CSV`}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) setUploads((current) => ({ ...current, [id]: file }));
                          }}
                        />
                      </label>
                      {uploads[id] && (
                        <button
                          className="fw-file-reset"
                          type="button"
                          onClick={() =>
                            setUploads((current) => {
                              const next = { ...current };
                              delete next[id];
                              return next;
                            })
                          }
                        >
                          Use server file
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {!local && (
                  <div className="fw-weather-row">
                    <label className="fw-field">
                      <span>Weather source</span>
                      <select
                        value={weatherSource}
                        onChange={(event) =>
                          setWeatherSource(event.target.value as 'noaa_gfs' | 'bundles')
                        }
                      >
                        <option value="noaa_gfs">NOAA GFS · automatic from internet</option>
                        <option value="bundles">Upload a weather.json bundle</option>
                      </select>
                    </label>
                    {weatherSource === 'noaa_gfs' ? (
                      <p>
                        <CloudSun size={17} /> Retrieves the weather forecast available at the
                        selected issue time, using each turbine’s coordinates.
                      </p>
                    ) : (
                      <label className="fw-field">
                        <span>Forecast weather JSON</span>
                        <input
                          type="file"
                          accept=".json,application/json"
                          onChange={(event) => setWeatherFile(event.target.files?.[0] ?? null)}
                        />
                        <small>Must cover the selected hours and turbines.</small>
                      </label>
                    )}
                  </div>
                )}
                <div className="fw-confirm-row">
                  <label className="fw-check">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    <span>
                      I confirm these CSV timestamp assumptions.
                      <small>
                        {zone === 'Etc/GMT-5' ? 'UTC+5' : zone} · 10-minute interval {interval}s ·{' '}
                        {delay} min reporting delay
                      </small>
                    </span>
                  </label>
                  <a
                    href="#forecast-advanced"
                    onClick={() => {
                      const el = document.getElementById('forecast-advanced');
                      if (el instanceof HTMLDetailsElement) el.open = true;
                    }}
                  >
                    Adjust settings <ChevronDown size={13} />
                  </a>
                </div>
              </>
            )}
          </fieldset>
          {real && (
            <details className="fw-details fw-advanced" id="forecast-advanced">
              <summary>
                <Settings2 size={16} />
                <span>Advanced settings & AI assistance</span>
                <small>Optional</small>
                <ChevronDown size={16} />
              </summary>
              <fieldset disabled={busy} className="fw-advanced-content">
                <legend className="fw-sr-only">Advanced forecast settings</legend>
                <div className="fw-advanced-grid">
                  <label className="fw-field">
                    <span>CSV timezone</span>
                    <select
                      value={zone}
                      disabled={local}
                      onChange={(event) => {
                        setZone(event.target.value);
                        setConfirmed(false);
                      }}
                    >
                      <option value="Etc/GMT-5">UTC+5 · fixed offset</option>
                      <option value="UTC">UTC</option>
                      <option value="Asia/Almaty">Asia/Almaty · historic timezone</option>
                    </select>
                  </label>
                  <label className="fw-field">
                    <span>10-minute timestamp label</span>
                    <select
                      value={interval}
                      disabled={local}
                      onChange={(event) => {
                        setIntervalLabel(event.target.value as 'start' | 'end');
                        setConfirmed(false);
                      }}
                    >
                      <option value="start">Interval start</option>
                      <option value="end">Interval end</option>
                    </select>
                  </label>
                  <label className="fw-field">
                    <span>Reporting delay · minutes</span>
                    <input
                      type="number"
                      min={0}
                      max={1440}
                      value={delay}
                      onChange={(event) => {
                        setDelay(Number(event.target.value));
                        setConfirmed(false);
                      }}
                    />
                  </label>
                  <label className="fw-field">
                    <span>Training history</span>
                    <select
                      value={policy}
                      onChange={(event) =>
                        setPolicy(event.target.value as 'available' | 'frozen_jan31')
                      }
                    >
                      <option value="available">Available by forecast issue</option>
                      <option value="frozen_jan31">Freeze at 31 January 2026</option>
                    </select>
                  </label>
                </div>
                <div className="fw-ai-options">
                  <label className="fw-check">
                    <input
                      type="checkbox"
                      checked={openai && !local}
                      disabled={local || !options.capabilities.openai}
                      onChange={(event) => setOpenai(event.target.checked)}
                    />
                    <span>
                      OpenAI workflow agent
                      <small>
                        {local
                          ? 'Available with Gradient Boosting.'
                          : options.capabilities.openai
                            ? 'Coordinates the same verified workflow. Uses API credits for each new run.'
                            : 'Configure OPENAI_API_KEY on the server to enable.'}
                      </small>
                    </span>
                    <Sparkles size={17} />
                  </label>
                  <label className="fw-check">
                    <input
                      type="checkbox"
                      checked={jev && !local}
                      disabled={local || !options.capabilities.jev}
                      onChange={(event) => setJev(event.target.checked)}
                    />
                    <span>
                      Jev · review the next 3 hours
                      <small>
                        {local
                          ? 'Available with Gradient Boosting.'
                          : options.capabilities.jev
                            ? 'Reviews operational concerns and suggests the next human check. Uses a TypeSafe API request.'
                            : 'Configure TYPESAFE_API_KEY on the server to enable.'}
                      </small>
                    </span>
                    <ShieldCheck size={17} />
                  </label>
                </div>
                {jev && !local && options.capabilities.jev && (
                  <div className="fw-note-editor">
                    <label className="fw-field">
                      <span>
                        Operator note <small>optional · up to 600 characters</small>
                      </span>
                      <textarea
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        maxLength={600}
                        rows={3}
                        placeholder="Add a known maintenance, curtailment or measurement concern…"
                      />
                    </label>
                    {note.trim() && (
                      <>
                        <div className="fw-advanced-grid">
                          <label className="fw-field">
                            <span>Note available at · UTC</span>
                            <input
                              type="datetime-local"
                              value={noteAvailable}
                              onChange={(event) => setNoteAvailable(event.target.value)}
                            />
                          </label>
                          <label className="fw-field">
                            <span>Note expires at · UTC</span>
                            <input
                              type="datetime-local"
                              value={noteUntil}
                              onChange={(event) => setNoteUntil(event.target.value)}
                            />
                          </label>
                        </div>
                        <div className="fw-note-scope">
                          <span>Affected turbines</span>
                          {TURBINES.map((id) => (
                            <label className="fw-check" key={id}>
                              <input
                                type="checkbox"
                                checked={noteTurbines.includes(id)}
                                onChange={(event) =>
                                  setNoteTurbines((current) =>
                                    event.target.checked
                                      ? [...current, id]
                                      : current.filter((item) => item !== id),
                                  )
                                }
                              />
                              Turbine {id.slice(1)}
                            </label>
                          ))}
                        </div>
                        <p className="fw-small">
                          Use the actual availability time. Historical runs exclude notes that were
                          not known at the forecast issue.
                        </p>
                      </>
                    )}
                  </div>
                )}
                {options.capabilities.auto_refresh && (
                  <label className="fw-check fw-auto-check">
                    <input
                      type="checkbox"
                      checked={autoRefresh}
                      onChange={(event) => setAutoRefresh(event.target.checked)}
                    />
                    <span>
                      Keep this forecast updated
                      <small>
                        The server checks for changed measurements and weather every five minutes.
                        Uploaded files are snapshots; replace them to supply new data.
                      </small>
                    </span>
                    <RefreshCw size={17} />
                  </label>
                )}
              </fieldset>
            </details>
          )}
          <div className="fw-submit-row">
            <div className="fw-submit-note">
              <ShieldCheck size={19} />
              <span>
                {problem ||
                  (real
                    ? local
                      ? 'Ready · local saved models, no weather request'
                      : 'Ready · input checks and a trace accompany every forecast'
                    : 'Ready · offline demo, no API keys needed')}
              </span>
            </div>
            <button type="submit" className="fw-primary" disabled={Boolean(problem) || busy}>
              {busy ? (
                <>
                  <LoaderCircle className="fw-spin" size={18} /> Forecast in progress
                </>
              ) : (
                <>
                  {real ? 'Generate forecast' : 'Run demo forecast'}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </div>
        </form>
      )}
      {(error || pollError || job?.error) && (
        <div className="fw-notice fw-error" role="alert">
          <TriangleAlert size={18} />
          <div>
            <strong>{pollError ? 'Connection interrupted' : 'Forecast needs attention'}</strong>
            <p>{error || pollError || job?.error}</p>
            {job?.result && (
              <p className="fw-small">Your last successful forecast remains available below.</p>
            )}
          </div>
        </div>
      )}
      {busy && (
        <div className="fw-progress" role="status" aria-live="polite">
          <span className="fw-progress-icon">
            <LoaderCircle className="fw-spin" size={22} />
          </span>
          <div>
            <strong>
              {submitting
                ? 'Preparing your request'
                : (labels[job?.phase ?? ''] ?? job?.phase ?? 'Running the forecast')}
            </strong>
            <p>
              {local
                ? 'Loading measurement history and the saved models. Keep this page open.'
                : 'Weather, data preparation, prediction and analysis run on the Python server. Weather retrieval may take a few minutes.'}
            </p>
          </div>
          <div className="fw-progress-track">
            <span />
          </div>
        </div>
      )}
      {job?.result && (
        <div ref={resultRef}>
          {(stale || restored) && (
            <div className="fw-notice">
              <Info size={17} />
              <span>
                {stale
                  ? 'Settings have changed. The results below belong to your previous run; generate a forecast to apply these inputs.'
                  : 'Restored your previous forecast. The result shows its saved model and issue time; the form above sets up a new run.'}
              </span>
            </div>
          )}
          <ForecastResults result={job.result} />
          {!job.result.is_synthetic && (
            <div className="fw-monitor-row">
              <span>
                <RefreshCw size={15} />
                <strong>{job.monitor.enabled ? 'Automatic updates on' : 'Saved forecast'}</strong>
                <small>
                  {job.monitor.enabled
                    ? 'The server checks inputs every 5 minutes.'
                    : 'Check the same inputs for a newer version.'}
                </small>
              </span>
              <div>
                <button type="button" disabled={busy || stale} onClick={refresh}>
                  Check for updates
                </button>
                <button
                  type="button"
                  disabled={busy || (stale && !job.monitor.enabled)}
                  onClick={() => updateMonitor(!job.monitor.enabled)}
                >
                  {job.monitor.enabled ? 'Pause updates' : 'Enable updates'}
                </button>
              </div>
            </div>
          )}
          <a className="fw-overview-link" href="#site-explorer">
            <ArrowDown size={14} /> Explore the site map and daily comparison below
          </a>
        </div>
      )}
      {!job?.result && !busy && (
        <div className="fw-empty-result">
          <span>
            <Wind size={25} />
          </span>
          <div>
            <strong>Your forecast will appear here.</strong>
            <p>Hourly power, wind speed, clear charts and downloadable reports — in one place.</p>
          </div>
        </div>
      )}
    </section>
  );
}
