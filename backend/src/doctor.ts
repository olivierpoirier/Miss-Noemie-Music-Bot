import "dotenv/config";
import { spawn } from "node:child_process";
import { createToolInspector } from "./toolDiagnostics.js";
import { MPV_CONFIG, YTDLP_CONFIG } from "./config.js";

const inspector = createToolInspector({ ytDlp: YTDLP_CONFIG.bin, mpv: MPV_CONFIG.bin });
const tools = await inspector.check();
for (const [name, tool] of Object.entries(tools)) {
  console.log(`${name}: ${tool.status} | version ${tool.version || "inconnue"}`);
  console.log(`  ${tool.path}`);
  console.log(`  ${tool.message}`);
}

if (process.argv.includes("--update-ytdlp")) {
  // Update the exact configured binary, including a bundled npm copy. This
  // explicit maintenance command is never run by startup or diagnostics.
  console.log(`Mise à jour de la copie utilisée par le bot : ${tools.ytDlp.path}`);
  const child = spawn(tools.ytDlp.path, ["--update"], { stdio: "inherit", windowsHide: true });
  const timer = setTimeout(() => { child.kill("SIGKILL"); process.exitCode = 1; }, 120_000);
  child.once("error", () => { clearTimeout(timer); process.exitCode = 1; console.error("Mise à jour impossible. Vérifie le chemin et les permissions."); });
  child.once("exit", (code) => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
} else if (Object.values(tools).some((tool) => tool.status === "error")) {
  process.exitCode = 1;
}
