export type ForecastModel = 'gradient_boosting' | 'local_history';
export type TurbineId = 'T1' | 'T2';

export interface ForecastOptions {
  schemaVersion: 1;
  models: { id: ForecastModel; label: string; available: boolean; reason?: string }[];
  defaults: {
    issue_time: string;
    horizon_hours: 24 | 48;
    turbine_ids: TurbineId[];
    source_timezone: string;
    interval_label: 'start' | 'end';
    reporting_delay_minutes: number;
    observation_policy: 'available' | 'frozen_jan31';
  };
  measurements: Record<TurbineId, { available: boolean; name: string }>;
  capabilities: { openai: boolean; jev: boolean; auto_refresh: boolean };
  sources: { id: string; label: string; url?: string }[];
}

export interface ForecastInput {
  mode: 'fixture' | 'historical' | 'live';
  model_kind: ForecastModel;
  issue_time: string;
  horizon_hours: 24 | 48;
  turbine_ids: TurbineId[];
  source_timezone: string;
  interval_label: 'start' | 'end';
  reporting_delay_minutes: number;
  assumptions_confirmed: boolean;
  observation_policy: 'available' | 'frozen_jan31';
  weather_source: 'noaa_gfs' | 'bundles';
  uploads?: Partial<Record<TurbineId, { name: string; content: string }>>;
  weather_upload?: { name: string; content: string };
  controller: 'deterministic' | 'openai';
  jev_enabled: boolean;
  operational_notes?: {
    text: string;
    turbine_ids: TurbineId[];
    available_at: string;
    valid_until: string;
  }[];
  auto_refresh: boolean;
}

export interface ForecastPoint {
  turbine_id: TurbineId;
  valid_time: string;
  lead_hours: number;
  prediction: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  wind_ms: number | null;
  temp_c: number | null;
}

export interface OperationsReview {
  state: string;
  message?: string;
  model?: string;
  by_turbine?: Record<
    string,
    {
      status: string;
      condition_label: string;
      recommendation: string;
      computed_flags: string[];
      uncertain: boolean;
      attention_probability?: number;
      action_confidence?: number;
    }
  >;
}

export interface ForecastOutput {
  run_id: string;
  issue_time: string;
  horizon_hours: number;
  model_id: string;
  is_synthetic: boolean;
  status: string;
  warnings: string[];
  summary: string;
  rows: ForecastPoint[];
  report: Record<string, unknown>;
  trace: { step?: string; status?: string; [key: string]: unknown }[];
  operations: OperationsReview | null;
  downloads: { csv: string; zip: string };
  dashboard_date: string;
}

export interface ForecastJob {
  id: string;
  state: 'queued' | 'running' | 'completed' | 'blocked' | 'failed';
  created_at: string;
  updated_at: string;
  phase: string;
  error: string | null;
  config: Partial<ForecastInput>;
  result: ForecastOutput | null;
  monitor: { enabled: boolean; state: string; next_check_at?: string | null };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('The forecast service returned an unreadable response. Please try again.');
  }
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `The forecast service could not complete this request (${response.status}).`;
    throw new Error(message);
  }
  return data;
}

export async function loadForecastOptions(signal?: AbortSignal): Promise<ForecastOptions> {
  const data = await request('/api/forecast/options', { signal });
  if (
    !data ||
    typeof data !== 'object' ||
    !('schemaVersion' in data) ||
    data.schemaVersion !== 1 ||
    !('models' in data) ||
    !Array.isArray(data.models) ||
    !('defaults' in data) ||
    !('measurements' in data) ||
    !('capabilities' in data)
  )
    throw new Error('Forecast configuration is unavailable. Restart the Python application.');
  return data as ForecastOptions;
}

function parseJob(data: unknown): ForecastJob {
  if (
    !data ||
    typeof data !== 'object' ||
    !('id' in data) ||
    typeof data.id !== 'string' ||
    !('state' in data) ||
    !['queued', 'running', 'completed', 'blocked', 'failed'].includes(String(data.state)) ||
    !('monitor' in data) ||
    !('result' in data)
  )
    throw new Error('The service returned an invalid forecast status.');
  const job = data as ForecastJob;
  if (job.result) {
    if (
      !Array.isArray(job.result.rows) ||
      !job.result.rows.length ||
      job.result.rows.some(
        (row) =>
          !['T1', 'T2'].includes(row.turbine_id) ||
          !Number.isFinite(Date.parse(row.valid_time)) ||
          !Number.isFinite(row.prediction) ||
          [row.p10, row.p50, row.p90, row.wind_ms, row.temp_c].some(
            (value) => value !== null && value !== undefined && !Number.isFinite(value),
          ),
      )
    )
      throw new Error('Forecast values failed the display checks. See the saved report.');
    for (const url of Object.values(job.result.downloads)) {
      if (!/^\/api\/forecast\/[^/?]+\/download\/(csv|zip)(\?run_id=[A-Za-z0-9_-]+)?$/.test(url))
        throw new Error('The forecast download address is invalid.');
    }
  }
  return job;
}

export async function createForecast(input: ForecastInput): Promise<ForecastJob> {
  return parseJob(await request('/api/forecast', { method: 'POST', body: JSON.stringify(input) }));
}

export async function loadForecast(id: string, signal?: AbortSignal): Promise<ForecastJob> {
  return parseJob(await request(`/api/forecast/${encodeURIComponent(id)}`, { signal }));
}

export async function refreshForecast(id: string): Promise<ForecastJob> {
  return parseJob(
    await request(`/api/forecast/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
      body: '{}',
    }),
  );
}

export async function setForecastMonitor(id: string, enabled: boolean): Promise<ForecastJob> {
  return parseJob(
    await request(`/api/forecast/${encodeURIComponent(id)}/monitor`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  );
}
