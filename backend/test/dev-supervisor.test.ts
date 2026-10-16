import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { startRestartingProcess } from "../../scripts/restartProcess.mjs";

test("optional process failures retry once with bounded backoff and recover after a stable run", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const children: EventEmitter[] = [];
  const delays: number[] = [];
  const stop = startRestartingProcess(() => {
    const child = new EventEmitter();
    // The launcher retains its own error handler for diagnostics.
    child.on("error", () => {});
    children.push(child);
    return child;
  }, { onRetry: (delay: number) => delays.push(delay) });
  t.after(stop);

  children.at(-1)!.emit("error", new Error("missing executable"));
  children.at(-1)!.emit("exit", 1);
  assert.deepEqual(delays, [1_000]);
  for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const count = children.length;
    t.mock.timers.tick(wait - 1);
    assert.equal(children.length, count);
    t.mock.timers.tick(1);
    assert.equal(children.length, count + 1);
    children.at(-1)!.emit("exit", 1);
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);

  t.mock.timers.tick(30_000);
  t.mock.timers.tick(60_000);
  children.at(-1)!.emit("exit", 1);
  assert.equal(delays.at(-1), 1_000);
});

test("stopping optional retries cancels timers and late process exits", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter();
  let launches = 0;
  const stop = startRestartingProcess(() => {
    launches++;
    return child;
  });
  child.emit("exit", 1);
  stop();
  t.mock.timers.tick(120_000);
  assert.equal(launches, 1);
  assert.equal(child.listenerCount("exit"), 0);

  const lateChild = new EventEmitter();
  const stopLate = startRestartingProcess(() => {
    launches++;
    return lateChild;
  });
  stopLate();
  lateChild.emit("exit", 0);
  t.mock.timers.tick(120_000);
  assert.equal(launches, 2);
});
