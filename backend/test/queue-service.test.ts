import assert from "node:assert/strict";
import test from "node:test";
import { createQueueService } from "../src/queue.js";
import type { QueueItem } from "../src/types.js";

function item(id: string, status: QueueItem["status"] = "queued"): QueueItem {
  return { id, status, url: `https://media.invalid/${id}`, thumb: null, createdAt: 1, durationSec: 10 };
}

function fixture(queue: QueueItem[] = [], history: QueueItem[] = []) {
  const store = { queue, history };
  const ids = { current: 1000 };
  const service = createQueueService(store, ids, { now: () => 1234, random: () => 0 });
  return { store, ids, service };
}

test("collection imports keep groups, metadata, and one acknowledgement identity", () => {
  const { store, service, ids } = fixture();
  const entries = [
    { url: "provider:spotify:first", title: "First", thumb: "cover", durationSec: 120 },
    { url: "provider:spotify:second", title: "", durationSec: 0 },
  ];
  const first = service.enqueueCollection(entries, { addedBy: "Olivier", clientRequestId: "request-1" });
  assert.deepEqual(first.map((entry) => entry.id), ["1000", "1001"]);
  assert.deepEqual(first.map((entry) => entry.group), ["pl_1000", "pl_1000"]);
  assert.deepEqual(first.map((entry) => entry.clientRequestId), ["request-1", undefined]);
  assert.ok(first.every((entry) => entry.addedBy === "Olivier" && entry.createdAt === 1234 && entry.status === "queued"));
  assert.equal(first[0].url, entries[0].url);
  assert.equal(first[0].thumb, "cover");
  assert.equal(first[1].title, "Titre en attente...");
  const next = service.enqueueCollection(entries, { addedBy: "Other" });
  assert.equal(next[0].group, "pl_1002");
  assert.equal(service.enqueueCollection([entries[0]], {})[0].group, undefined);
  assert.deepEqual(service.enqueueCollection([], {}), []);
  assert.equal(ids.current, 1005);
  assert.equal(store.queue.length, 5);
});

test("partial reorders ignore duplicate and missing IDs without losing queue items", () => {
  const a = item("a"), b = item("b"), c = item("c");
  const current = item("current", "playing"), pending = item("pending", "pending"), failed = item("failed", "error");
  const { store, service } = fixture([a, current, b, pending, c, failed]);
  service.reorder(["c", "c", "missing", "current", "a"]);
  assert.deepEqual(store.queue, [current, pending, failed, c, a, b]);
  assert.equal(new Set(store.queue).size, 6);
  service.reorder([]);
  assert.deepEqual(store.queue, [current, pending, failed, c, a, b]);
});

test("shuffle preserves active and pending items and every queued object", () => {
  const a = item("a"), b = item("b"), c = item("c");
  const current = item("current", "playing"), pending = item("pending", "pending");
  const { store, service } = fixture([a, current, b, pending, c]);
  service.shuffle();
  assert.deepEqual(store.queue, [current, pending, b, c, a]);
  assert.equal(new Set(store.queue).size, 5);
  assert.equal(current.status, "playing");
  assert.equal(pending.status, "pending");
});

test("remove delegates active playback cancellation and snapshots retire only finished items", () => {
  const current = item("current", "playing"), pending = item("pending", "pending");
  const removed = item("removed"), queued = item("queued"), failed = item("failed", "error");
  const { store, service } = fixture([current, removed, pending, queued, failed]);
  assert.equal(service.remove("unknown"), "missing");
  assert.equal(service.remove(current.id), "playing");
  assert.equal(current.status, "playing");
  assert.equal(service.remove(removed.id), "removed");
  const snapshot = service.snapshot();
  assert.deepEqual(store.queue, [current, pending, queued]);
  assert.deepEqual(snapshot.queue, [queued]);
  assert.deepEqual(snapshot.stats, { totalQueued: 1, remainingTimeSec: 10 });
  assert.deepEqual(store.history, []);
  service.clear();
  assert.equal(current.status, "done");
  assert.equal(queued.status, "done");
  assert.equal(pending.status, "pending");
  assert.deepEqual(service.snapshot().queue, []);
  assert.deepEqual(store.queue, [pending]);
});

test("history uses immutable snapshots, de-duplicates, and bounds long sessions", () => {
  const history = Array.from({ length: 200 }, (_, index) => item(String(index), "done"));
  const { store, service } = fixture([], history);
  const current = { ...item("new", "playing"), title: "Original title" };
  service.addToHistory(current);
  current.title = "Changed later";
  assert.equal(current.status, "playing");
  assert.equal(store.history.length, 200);
  assert.equal(store.history[0].status, "done");
  assert.equal(store.history[0].title, "Original title");
  assert.equal(store.history.at(-1)?.id, "198");
  service.addToHistory({ ...item("100"), title: "Played again" });
  assert.equal(store.history.length, 200);
  assert.equal(store.history.filter((entry) => entry.id === "100").length, 1);
  assert.equal(store.history[0].title, "Played again");
});

test("history requeue clamps insertion indexes, retains groups, and assigns fresh identities", () => {
  for (const [index, expected] of [[-10, 0], [1.9, 1], [999, 2], [NaN, 2], [Infinity, 2], [undefined, 2]] as const) {
    const source = { ...item("old", "done"), group: "playlist", addedBy: "Olivier", clientRequestId: "old-request" };
    const a = item("a"), b = item("b"), current = item("current", "playing");
    const { store, service, ids } = fixture([a, current, b], [source]);
    assert.equal(service.requeueHistory("missing", index), null);
    assert.equal(ids.current, 1000);
    const restored = service.requeueHistory("old", index)!;
    assert.equal(restored.id, "1000");
    assert.equal(restored.group, "playlist");
    assert.equal(restored.addedBy, "Olivier");
    assert.equal(restored.url, source.url);
    assert.equal(restored.durationSec, source.durationSec);
    assert.equal(restored.clientRequestId, undefined);
    assert.equal(store.queue[0], current);
    assert.equal(store.queue.filter((entry) => entry.status === "queued").indexOf(restored), expected);
    assert.deepEqual(store.history, [source]);
    assert.equal(source.status, "done");
  }
});

test("previous restores the latest snapshot before the current track without duplicating it", () => {
  const previous = { ...item("old", "done"), group: "playlist" };
  const older = item("older", "done"), current = item("current", "playing"), next = item("next"), pending = item("pending", "pending");
  const { store, service } = fixture([current, pending, next], [previous, older]);
  const restored = service.restorePrevious(current)!;
  assert.equal(restored.id, "1000");
  assert.equal(restored.createdAt, 1234);
  assert.equal(restored.group, previous.group);
  assert.equal(restored.url, previous.url);
  assert.deepEqual(store.queue, [pending, restored, current, next]);
  assert.equal(current.status, "queued");
  assert.equal(store.queue.filter((entry) => entry.id === current.id).length, 1);
  assert.deepEqual(store.history, [older]);
  assert.equal(previous.status, "done");
  const empty = fixture([item("still-playing", "playing")]);
  const originalQueue = empty.store.queue;
  assert.equal(empty.service.restorePrevious(originalQueue[0]), null);
  assert.equal(empty.store.queue, originalQueue);
  assert.equal(originalQueue[0].status, "playing");
});

test("skip group retires matching queued tracks while leaving playback cancellation to the player", () => {
  const current = { ...item("current", "playing"), group: "group" };
  const grouped = { ...item("grouped"), group: "group" };
  const other = { ...item("other"), group: "other" };
  const pending = { ...item("pending", "pending"), group: "group" };
  const { service } = fixture([current, grouped, other, pending]);
  service.finishQueuedGroup("group");
  assert.equal(current.status, "playing");
  assert.equal(grouped.status, "done");
  assert.equal(other.status, "queued");
  assert.equal(pending.status, "pending");
});
