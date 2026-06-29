import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const withTunnel = process.argv.includes("--tunnel");
const checkOnly = process.argv.includes("--check");
const isWindows = process.platform === "win32";

const children = new Set();
let shuttingDown = false;

function prefixLines(label, chunk) {
  const lines = chunk.toString().split(/\r?\n/);
  for (const line of lines) {
    if (line.trim()) {
      console.log(`[${label}] ${line}`);
    }
  }
}

function startProcess(label, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR || "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  children.add(child);

  child.stdout?.on("data", (chunk) => prefixLines(label, chunk));
  child.stderr?.on("data", (chunk) => prefixLines(label, chunk));

  child.on("error", (error) => {
    console.error(`[${label}] ${error.message}`);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;

    if (code && code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
      shutdown(code);
      return;
    }

    if (signal) {
      console.error(`[${label}] stopped by ${signal}`);
      shutdown(1);
    }
  });

  return child;
}

function requestOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });

    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitFor(url, label, timeoutMs = 45_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await requestOk(url)) {
      console.log(`[dev] ${label} pret`);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`${label} n'a pas repondu a temps (${url})`);
}

function canListen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

async function findAvailablePort(startPort, maxAttempts = 40) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    if (await canListen(port)) {
      return port;
    }
  }

  throw new Error(
    `Aucun port frontend libre trouve entre ${startPort} et ${
      startPort + maxAttempts - 1
    }`
  );
}

function killTree(child) {
  if (!child.pid) return;

  if (isWindows) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  child.kill("SIGTERM");
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    killTree(child);
  }

  setTimeout(() => process.exit(code), 250);
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

async function main() {
  if (checkOnly) {
    const requiredFiles = [
      "backend/node_modules/tsx/dist/cli.mjs",
      "frontend/node_modules/vite/bin/vite.js",
    ];

    for (const relativePath of requiredFiles) {
      const fullPath = path.join(rootDir, relativePath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Dependance manquante: ${relativePath}`);
      }
    }

    console.log("[dev] verification ok");
    return;
  }

  console.log("[dev] Demarrage du backend local...");
  startProcess(
    "backend",
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "watch", "src/server.ts"],
    path.join(rootDir, "backend")
  );

  await waitFor("http://127.0.0.1:4000/health", "backend");

  const frontendPort = await findAvailablePort(5173);
  console.log("[dev] Demarrage du frontend local...");
  startProcess(
    "frontend",
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "0.0.0.0",
      "--port",
      String(frontendPort),
      "--strictPort",
    ],
    path.join(rootDir, "frontend")
  );

  await waitFor(`http://127.0.0.1:${frontendPort}`, "frontend");
  console.log(`[dev] Frontend local: http://localhost:${frontendPort}`);

  if (withTunnel) {
    console.log("[dev] Demarrage du tunnel Cloudflare...");
    startProcess(
      "tunnel",
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${frontendPort}`],
      rootDir
    );
  }
}

main().catch((error) => {
  console.error(`[dev] ${error.message}`);
  shutdown(1);
});
