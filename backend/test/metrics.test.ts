import assert from "node:assert/strict";
import test from "node:test";
import { getMetrics, recordBackendMetric } from "../src/metrics.js";

test("backend metrics are bounded, finite and returned as independent snapshots", () => {
  for (let i = 0; i < 105; i++) recordBackendMetric("test", i, true, { hit: true });
  recordBackendMetric("test-invalid", Infinity, false, { hit: false });
  const snapshot = getMetrics();
  assert.equal(snapshot.length, 100);
  assert.equal(snapshot.at(-1)?.durationMs, 0);
  snapshot[0].name = "mutated";
  snapshot[0].data!.hit = false;
  assert.equal(getMetrics()[0].name, "test");
  assert.equal(getMetrics()[0].data!.hit, true);
});

test("public metric data excludes credentials, signed links and Spotify identifiers", () => {
  recordBackendMetric("test-safe", 12.4, true, {
    provider: "spotify", hit: true, token: "private", url: "https://signed.example/?token=private",
    source: "https://signed.example/?token=private", endpoint: "/v1/tracks/private-id?token=private",
    status: 200, expectedDuration: true,
  });
  assert.deepEqual(getMetrics().at(-1)?.data, {
    provider: "spotify", hit: true, endpoint: "/v1/tracks/:id", status: 200, expectedDuration: true,
  });
});
