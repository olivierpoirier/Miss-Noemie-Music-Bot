import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AUDIO_PROFILES } from "../src/audioProfiles.js";
import { MPV_CONFIG } from "../src/config.js";

// Render to a file: these checks need mpv, but never open a sound device or
// contact a media service. CI without mpv can still run the other unit tests.
const mpvAvailable = spawnSync(MPV_CONFIG.bin, ["--version"], {
  stdio: "ignore", timeout: 5_000,
}).status === 0;
const sampleRate = 48_000;

function render(profile: keyof typeof AUDIO_PROFILES, samples: Float32Array): Float32Array {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "music-bot-audio-"));
  try {
    const sourcePath = path.join(directory, "source.wav");
    const outputPath = path.join(directory, "output.raw");
    const wav = Buffer.alloc(44 + samples.length * 4);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(3, 20); // IEEE float, interleaved stereo.
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 8, 28);
    wav.writeUInt16LE(8, 32);
    wav.writeUInt16LE(32, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples.length * 4, 40);
    for (let i = 0; i < samples.length; i++) wav.writeFloatLE(samples[i], 44 + i * 4);
    fs.writeFileSync(sourcePath, wav);

    const result = spawnSync(MPV_CONFIG.bin, [
      ...MPV_CONFIG.baseArgs,
      // Unity volume isolates the filter's gain/ceiling. Runtime profile
      // volumes are lower and provide additional margin after this stage.
      "--volume=100",
      `--af=${AUDIO_PROFILES[profile].filters}`,
      "--ao=pcm", "--ao-pcm-waveheader=no",
      `--ao-pcm-file=${outputPath}`,
      // The live route holds its device open with silence; an untimed file
      // output must only write decoded samples, not that device keepalive.
      "--audio-stream-silence=no",
      "--idle=no", "--msg-level=all=warn", sourcePath,
    ], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    assert.ok(fs.statSync(outputPath).size <= samples.length * 4 + 65_536, "unexpected padding in file output");
    const output = fs.readFileSync(outputPath);
    assert.equal(output.length % 8, 0, "output must contain complete float stereo frames");
    return Float32Array.from({ length: output.length / 4 }, (_, i) => output.readFloatLE(i * 4));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("balanced preserves quiet stereo samples and the very end of a track", { skip: !mpvAvailable }, () => {
  const source = new Float32Array(12_000 * 2);
  for (let frame = 0; frame < source.length / 2; frame++) {
    source[frame * 2] = 0.2 * Math.sin(2 * Math.PI * 440 * frame / sampleRate);
    source[frame * 2 + 1] = 0.1 * Math.sin(2 * Math.PI * 997 * frame / sampleRate);
  }
  // A last-frame transient detects lookahead truncation even for short files.
  source[source.length - 2] = 0.3;
  source[source.length - 1] = -0.2;
  const output = render("balanced", source);
  assert.equal(output.length, source.length, "lookahead must not shorten or extend the track");
  let error = 0;
  for (let i = 0; i < source.length; i++) error = Math.max(error, Math.abs(output[i] - source[i]));
  assert.ok(error < 0.000001, `quiet music must keep its samples, channels and gain (error=${error})`);
});

test("balanced limits overloaded samples with headroom before voice encoding", { skip: !mpvAvailable }, () => {
  const source = new Float32Array(sampleRate * 2);
  for (let frame = 0; frame < sampleRate; frame++) {
    source[frame * 2] = 1.4 * Math.sin(2 * Math.PI * 440 * frame / sampleRate);
    source[frame * 2 + 1] = 1.2 * Math.sin(2 * Math.PI * 997 * frame / sampleRate);
  }
  const output = render("balanced", source);
  assert.equal(output.length, source.length);
  let peak = 0;
  for (const sample of output) {
    assert.ok(Number.isFinite(sample));
    peak = Math.max(peak, Math.abs(sample));
  }
  assert.ok(peak > 0.8 && peak <= 0.891252, `expected a limited sample peak near -1 dBFS, got ${peak}`);
});

test("Xbox voice-chat processing still renders finite mono audio without clipping", { skip: !mpvAvailable }, () => {
  const source = new Float32Array(12_000 * 2);
  for (let frame = 0; frame < source.length / 2; frame++) {
    source[frame * 2] = 1.4 * Math.sin(2 * Math.PI * 440 * frame / sampleRate);
    source[frame * 2 + 1] = 1.2 * Math.sin(2 * Math.PI * 997 * frame / sampleRate);
  }
  const output = render("xbox", source);
  assert.equal(output.length, source.length);
  let peak = 0;
  for (let i = 0; i < output.length; i += 2) {
    assert.ok(Number.isFinite(output[i]));
    assert.equal(output[i], output[i + 1]);
    peak = Math.max(peak, Math.abs(output[i]));
  }
  assert.ok(peak > 0.1 && peak <= 0.883501, `expected limited, non-silent Xbox audio, got ${peak}`);
});
