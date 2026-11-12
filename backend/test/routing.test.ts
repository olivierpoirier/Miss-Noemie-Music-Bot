import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args === 'list short sinks') fs.writeSync(1, '1\\txmbot_sink\\tmodule-null-sink.c\\n');
if (args === 'list short sources' && process.env.TEST_MONITOR === '1') fs.writeSync(1, '2\\txmbot_sink.monitor\\tmodule-null-sink.c\\n');
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
    assert.equal(routing.getRuntimeAudioRouting().virtualMonitorSource, "xmbot_sink.monitor");
    assert.match(routing.getRuntimeAudioRouting().message || "", /Par défaut/);
    const first = routing.ensureAudioRoutingReady();
    const second = routing.ensureAudioRoutingReady();
    assert.strictEqual(first, second);
    assert.equal(await first, true);
  } finally {
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux creates a floating-point stereo sink and named input once, then preserves both", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-bot-routing-create-"));
  const previous = { ...process.env };
  const { AUDIO_CONFIG } = await import("../src/config.js");
  const previousConfig = { ...AUDIO_CONFIG };
  const sinkName = "xmbot_creation_test";
  const sourceName = "xmbot_creation_input";
  const logFile = path.join(directory, "pactl.jsonl");
  try {
    await writeFile(path.join(directory, "pactl"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const logFile = ${JSON.stringify(logFile)};
const stateFile = ${JSON.stringify(path.join(directory, "created"))};
const sourceFile = ${JSON.stringify(path.join(directory, "input-created"))};
const sinkName = ${JSON.stringify(sinkName)};
const sourceName = ${JSON.stringify(sourceName)};
fs.appendFileSync(logFile, JSON.stringify(args) + '\\n');
if (args[0] === 'load-module') {
  fs.writeFileSync(args[1] === 'module-null-sink' ? stateFile : sourceFile, 'created');
  fs.writeSync(1, '42\\n');
} else if (args[0] === 'list' && fs.existsSync(stateFile)) {
  if (args[2] === 'sinks') fs.writeSync(1, '1\\t' + sinkName + '\\tmodule-null-sink.c\\n');
  if (args[2] === 'sources') {
    fs.writeSync(1, '2\\t' + sinkName + '.monitor\\tmodule-null-sink.c\\n');
    if (fs.existsSync(sourceFile)) fs.writeSync(1, '3\\t' + sourceName + '\\tmodule-remap-source.c\\n');
  }
}
`, { mode: 0o755 });
    process.env.PATH = `${directory}${path.delimiter}${previous.PATH}`;
    AUDIO_CONFIG.linuxEnableVirtualSink = true;
    AUDIO_CONFIG.linuxVirtualSinkName = sinkName;
    AUDIO_CONFIG.linuxVirtualSourceName = sourceName;
    const routing = await import("../src/utils.js");

    assert.equal(await routing.ensureAudioRoutingReady(), true);
    assert.equal(routing.isVirtualAudioRoutingReady(), true);
    assert.equal(routing.getRuntimeAudioRouting().audioDevice, `pulse/${sinkName}`);
    assert.equal(routing.getRuntimeAudioRouting().virtualMonitorSource, sourceName);
    assert.equal(await routing.ensureAudioRoutingReady(), true);

    const commands: string[][] = (await readFile(logFile, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const creates = commands.filter((args) => args[0] === "load-module");
    assert.equal(creates.length, 2, "existing routes must retain their configuration");
    assert.equal(creates[0][1], "module-null-sink");
    for (const argument of [
      `sink_name=${sinkName}`,
      "format=float32le",
      "rate=48000",
      "channels=2",
      "channel_map=front-left,front-right",
    ]) assert.ok(creates[0].includes(argument), `missing audio setting: ${argument}`);
    assert.equal(creates[1][1], "module-remap-source");
    for (const argument of [
      `source_name=${sourceName}`,
      `master=${sinkName}.monitor`,
      "source_properties=device.description=Music-Bot-Stereo",
      "format=float32le", "rate=48000", "channels=2",
      "master_channel_map=front-left,front-right",
      "channel_map=front-left,front-right", "remix=no",
    ]) assert.ok(creates[1].includes(argument), `missing input setting: ${argument}`);
    assert.deepEqual(commands.filter((args) => args[0].startsWith("set-")), [
      ["set-source-volume", sourceName, "0dB"],
    ], "only a newly created input has its gain initialized");
  } finally {
    Object.assign(AUDIO_CONFIG, previousConfig);
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux reuses a named input, but still requires its sink monitor", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-bot-routing-input-"));
  const previous = { ...process.env };
  const { AUDIO_CONFIG } = await import("../src/config.js");
  const previousConfig = { ...AUDIO_CONFIG };
  const logFile = path.join(directory, "pactl.jsonl");
  try {
    await writeFile(path.join(directory, "pactl"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
if (args.join(' ') === 'list short sinks') fs.writeSync(1, '1\\txmbot_sink\\tmodule-null-sink.c\\n');
if (args.join(' ') === 'list short sources') {
  fs.writeSync(1, '3\\txmbot_input\\tmodule-remap-source.c\\n');
  if (process.env.TEST_MONITOR === '1') fs.writeSync(1, '2\\txmbot_sink.monitor\\tmodule-null-sink.c\\n');
}
if (args[0] === 'load-module' || args[0].startsWith('set-')) process.exit(1);
`, { mode: 0o755 });
    process.env.PATH = `${directory}${path.delimiter}${previous.PATH}`;
    process.env.TEST_MONITOR = "1";
    Object.assign(AUDIO_CONFIG, {
      linuxVirtualSinkName: "xmbot_sink",
      linuxVirtualSourceName: "xmbot_input",
    });
    const routing = await import("../src/utils.js");
    assert.equal(await routing.ensureAudioRoutingReady(), true);
    assert.equal(routing.getRuntimeAudioRouting().virtualMonitorSource, "xmbot_input");
    const commands: string[][] = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(commands.every((args) => args[0] !== "load-module" && !args[0].startsWith("set-")));

    process.env.TEST_MONITOR = "0";
    assert.equal(await routing.ensureAudioRoutingReady(), false);
    assert.equal(routing.getRuntimeAudioRouting().audioDevice, null);
    assert.equal(routing.getRuntimeAudioRouting().virtualMonitorSource, null);
  } finally {
    Object.assign(AUDIO_CONFIG, previousConfig);
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux keeps the monitor ready if a successful alias load exposes no source", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-bot-routing-hidden-input-"));
  const previous = { ...process.env };
  const { AUDIO_CONFIG } = await import("../src/config.js");
  const previousConfig = { ...AUDIO_CONFIG };
  try {
    await writeFile(path.join(directory, "pactl"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.join(' ') === 'list short sinks') fs.writeSync(1, '1\\txmbot_sink\\tmodule-null-sink.c\\n');
if (args.join(' ') === 'list short sources') fs.writeSync(1, '2\\txmbot_sink.monitor\\tmodule-null-sink.c\\n');
if (args[0] === 'load-module') fs.writeSync(1, '42\\n');
if (args[0].startsWith('set-')) process.exit(1);
`, { mode: 0o755 });
    process.env.PATH = `${directory}${path.delimiter}${previous.PATH}`;
    Object.assign(AUDIO_CONFIG, {
      linuxVirtualSinkName: "xmbot_sink",
      linuxVirtualSourceName: "xmbot_input",
    });
    const routing = await import("../src/utils.js");
    assert.equal(await routing.ensureAudioRoutingReady(), true);
    assert.equal(routing.isVirtualAudioRoutingReady(), true);
    assert.equal(routing.getRuntimeAudioRouting().virtualMonitorSource, "xmbot_sink.monitor");
    assert.match(routing.getRuntimeAudioRouting().message || "", /Par défaut/);
  } finally {
    Object.assign(AUDIO_CONFIG, previousConfig);
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
