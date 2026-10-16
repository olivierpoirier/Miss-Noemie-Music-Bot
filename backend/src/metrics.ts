import { performance } from "node:perf_hooks";

export type Span = {
  name: string;
  t0: number;
  t1?: number;
  data?: Record<string, unknown>;
};

export function startSpan(name: string, data?: Record<string, unknown>) {
  const s: Span = { name, t0: performance.now(), data };
  return {
    end(extra?: Record<string, unknown>) {
      s.t1 = performance.now();
      if (extra) s.data = { ...(s.data || {}), ...extra };
      return s;
    },
    span: s,
  };
}

export type PlayMetrics = {
  id: string;
  spans: Span[];
  startedAt: number;
};

const LAST: PlayMetrics[] = [];

export function pushMetrics(m: PlayMetrics) {
  LAST.push(m);
  while (LAST.length > 100) LAST.shift();
  console.log(`[metrics] push id=${m.id} spans=${m.spans.length}`);
}

export type BackendMetric = {
  id: string;
  name: string;
  ok: boolean;
  durationMs: number;
  at: number;
  data?: Record<string, unknown>;
};

const BACKEND_LAST: BackendMetric[] = [];

function nextMetricId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const METRIC_FIELDS = new Set([
  "provider", "hit", "platform", "mode", "source", "status", "changed",
  "timeout", "spawnError", "exitCode", "outputLimit", "limit", "expectedDuration", "endpoint",
]);

function metricData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!METRIC_FIELDS.has(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      safe[key] = value;
    } else if (typeof value === "string") {
      if (key === "endpoint") {
        const segments = new Set(["v1", "tracks", "albums", "playlists", "items"]);
        safe[key] = value.split("?")[0].split("/").map((part) => !part || segments.has(part) ? part : ":id").join("/").slice(0, 120);
      } else if (/^[a-z0-9_-]{1,64}$/i.test(value)) {
        safe[key] = value;
      }
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

export function recordBackendMetric(
  name: string,
  durationMs: number,
  ok: boolean,
  data?: Record<string, unknown>
): void {
  BACKEND_LAST.push({
    id: nextMetricId(),
    name,
    ok,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    at: Date.now(),
    data: metricData(data),
  });

  while (BACKEND_LAST.length > 100) BACKEND_LAST.shift();
}

export function getMetrics(): BackendMetric[] {
  return BACKEND_LAST.map((metric) => ({ ...metric, ...(metric.data ? { data: { ...metric.data } } : {}) }));
}
