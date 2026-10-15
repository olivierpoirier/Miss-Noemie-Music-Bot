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
const backendPort = Number(process.env.PORT || 4000);

// Retain exited parents too: descendants may still belong to their group.
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
      XMB_BACKEND_PORT: String(backendPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
    detached: !isWindows,
  });

  children.add(child);

  child.stdout?.on("data", (chunk) => prefixLines(label, chunk));
  child.stderr?.on("data", (chunk) => prefixLines(label, chunk));

  child.on("error", (error) => {
    console.error(`[${label}] ${error.message}`);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    console.error(`[${label}] ${signal ? `stopped by ${signal}` : `exited with code ${code}`}`);
    shutdown(code || 1);
  });

  return child;
}

function requestOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
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

function killTree(child, signal = "SIGTERM") {
  if (!child.pid) return;

  if (isWindows) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  // tsx watch and Vite can create descendants. Killing their direct parent
  // alone leaves stale servers holding ports after Ctrl+C or a failed startup.
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") child.kill(signal);
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  const processes = [...children];
  if (processes.length === 0) process.exit(code);
  for (const child of processes) {
    killTree(child);
  }

  // Give the backend time to stop mpv and release audio routing before forcing
  // down any descendants that ignore SIGTERM.
  setTimeout(() => {
    if (!isWindows) {
      for (const child of processes) killTree(child, "SIGKILL");
    }
    process.exit(code);
  }, 5000);
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

async function main() {
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) {
    throw new Error("PORT doit etre un entier entre 1 et 65535.");
  }

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

  if (!await canListen(backendPort)) {
    throw new Error(`Le port backend ${backendPort} est deja utilise. Arrete le serveur existant ou choisis un autre PORT.`);
  }

  console.log("[dev] Demarrage du backend local...");
  startProcess(
    "backend",
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "watch", "src/server.ts"],
    path.join(rootDir, "backend")
  );

  await waitFor(`http://127.0.0.1:${backendPort}/health`, "backend");

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
