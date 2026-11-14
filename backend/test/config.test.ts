import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

async function extractorArgs(runtime?: string): Promise<string[]> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  if (runtime !== undefined) env.YTDLP_JS_RUNTIME = runtime;
  // A fresh process isolates import-time configuration and never loads .env.
  const script = `
    console.log = () => {};
    console.warn = () => {};
    const { YTDLP_CONFIG } = await import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)});
    process.stdout.write(JSON.stringify(YTDLP_CONFIG.baseArgs));
  `;
  const { stdout } = await run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), env, timeout: 5_000, maxBuffer: 65_536,
  });
  return JSON.parse(stdout);
}

test("YouTube challenges use the backend's Node executable without separate runtime setup", async () => {
  for (const runtime of [undefined, "  "]) {
    const args = await extractorArgs(runtime);
    assert.equal(args[args.indexOf("--js-runtimes") + 1], `node:${process.execPath}`);
    assert.equal(args.filter((arg) => arg === "--js-runtimes").length, 1);
  }
});

test("explicit YouTube runtime settings preserve paths with spaces as one argument", async () => {
  const runtime = "deno:/configured runtime/deno";
  const args = await extractorArgs(`  ${runtime}  `);
  assert.equal(args[args.indexOf("--js-runtimes") + 1], runtime);
  assert.equal(args.includes(`node:${process.execPath}`), false);
});
