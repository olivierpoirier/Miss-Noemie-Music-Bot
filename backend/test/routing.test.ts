import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Linux routing requires a real monitor and accepts a manually created sink", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-bot-routing-"));
  const previous = { ...process.env };
  try {
    await writeFile(path.join(directory, "pactl"), `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
if (args === 'list short sinks') console.log('1\\txmbot_sink\\tmodule-null-sink.c');
if (args === 'list short sources' && process.env.TEST_MONITOR === '1') console.log('2\\txmbot_sink.monitor\\tmodule-null-sink.c');
if (args.startsWith('load-module')) process.exit(1);
`, { mode: 0o755 });
    process.env.PATH = `${directory}${path.delimiter}${previous.PATH}`;
    process.env.LINUX_ENABLE_VIRTUAL_SINK = "false";
    process.env.LINUX_VIRTUAL_SINK_NAME = "xmbot_sink";
    process.env.TEST_MONITOR = "0";
    const routing = await import("../src/utils.js");
    assert.equal(await routing.ensureAudioRoutingReady(), false);
    assert.equal(routing.isVirtualAudioRoutingReady(), false);
    assert.equal(routing.getRuntimeAudioRouting().audioDevice, null);

    process.env.TEST_MONITOR = "1";
    assert.equal(await routing.ensureAudioRoutingReady(), true);
    assert.equal(routing.isVirtualAudioRoutingReady(), true);
    assert.equal(routing.getRuntimeAudioRouting().audioDevice, "pulse/xmbot_sink");
    const first = routing.ensureAudioRoutingReady();
    const second = routing.ensureAudioRoutingReady();
    assert.strictEqual(first, second);
    assert.equal(await first, true);
  } finally {
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
