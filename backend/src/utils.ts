import { spawn, spawnSync } from "child_process";
import fs from "fs";
import { APP_CONFIG, AUDIO_CONFIG } from "./config.js";

export type RuntimeAudioRouting = {
  audioDevice: string | null;
  virtualSinkName: string | null;
  virtualMonitorSource: string | null;
  degraded: boolean;
  message: string | null;
};

let runtimeAudioRouting: RuntimeAudioRouting = {
  audioDevice: null,
  virtualSinkName: null,
  virtualMonitorSource: null,
  degraded: false,
  message: null,
};

export function getRuntimeAudioRouting(): RuntimeAudioRouting {
  return { ...runtimeAudioRouting };
}

/**
 * The player must never silently fall back to desktop speakers.  A real virtual
 * sink/input needs both an output device and a monitor/source exposed to the
 * calling application.
 */
export function isVirtualAudioRoutingReady(): boolean {
  return Boolean(
    !runtimeAudioRouting.degraded &&
      runtimeAudioRouting.audioDevice &&
      runtimeAudioRouting.virtualSinkName &&
      runtimeAudioRouting.virtualMonitorSource
  );
}

function setRuntimeAudioRouting(
  patch: Partial<RuntimeAudioRouting>
): RuntimeAudioRouting {
  runtimeAudioRouting = {
    ...runtimeAudioRouting,
    ...patch,
  };

  return getRuntimeAudioRouting();
}

function runCommand(command: string, args: string[]) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });

    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      error: result.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error,
    };
  }
}

function commandExists(command: string): boolean {
  const probe = runCommand(command, ["--version"]);
  return probe.ok || !probe.error;
}

/* ------------------------------------------------ */
/* WINDOWS / VOICEMEETER                            */
/* ------------------------------------------------ */

async function getVoicemeeterApi(): Promise<any> {
  const mod = await import("voicemeeter-connector");
  return (mod as any).Voicemeeter ?? (mod as any).default?.Voicemeeter ?? (mod as any).default;
}

function isVoiceMeeterRunning(): boolean {
  const stdout = runCommand("tasklist", [
    "/FI",
    `IMAGENAME eq ${AUDIO_CONFIG.windowsVoicemeeterExeName}`,
    "/NH",
  ]);

  if (!stdout.ok) return false;

  return stdout.stdout
    .toLowerCase()
    .includes(AUDIO_CONFIG.windowsVoicemeeterExeName.toLowerCase());
}

async function configureVoicemeeterSettings(): Promise<void> {
  const Voicemeeter = await getVoicemeeterApi();
  const vm = await Voicemeeter.init();

  try {
    vm.connect();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const index of [3, 4]) {
      await vm.setStripParameter(index, "A1", 1);
      await vm.setStripParameter(index, "B2", 1);
      await vm.setStripParameter(index, "Gain", 0);
    }
    console.log("✅ VoiceMeeter : A1 et B2 configurés avec succès.");
  } finally {
    if (vm.isConnected) vm.disconnect();
  }
}

async function ensureWindowsAudioReady(): Promise<boolean> {
  const vmPath = AUDIO_CONFIG.windowsVoicemeeterPath;

  if (!fs.existsSync(vmPath)) {
    setRuntimeAudioRouting({
      audioDevice: null,
      virtualSinkName: null,
      virtualMonitorSource: null,
      degraded: true,
      message:
        "VoiceMeeter introuvable. La lecture est bloquée jusqu'à ce que le routage virtuel soit prêt.",
    });

    return false;
  }

  try {
    if (!isVoiceMeeterRunning()) {
      const child = spawn(vmPath, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });

      // Spawn errors arrive asynchronously and must have a listener even when
      // the executable existed during the preceding filesystem check.
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    await configureVoicemeeterSettings();

    setRuntimeAudioRouting({
      audioDevice: AUDIO_CONFIG.windowsMpvAudioDevice,
      virtualSinkName: "VoiceMeeter",
      virtualMonitorSource: "B2",
      degraded: false,
      message: "Routage VoiceMeeter prêt.",
    });

    return true;
  } catch (error) {
    console.error("❌ VoiceMeeter non prêt :", error);

    setRuntimeAudioRouting({
      audioDevice: null,
      virtualSinkName: null,
      virtualMonitorSource: null,
      degraded: true,
      message:
        "VoiceMeeter a échoué à s'initialiser. La lecture reste bloquée.",
    });

    return false;
  }
}

/* ------------------------------------------------ */
/* LINUX / VIRTUAL SINK                             */
/* ------------------------------------------------ */

type PactlShortEntry = {
  index: string;
  name: string;
  raw: string;
};

function pactlAvailable(): boolean {
  if (!commandExists("pactl")) return false;

  const info = runCommand("pactl", ["info"]);
  return info.ok;
}

function listPactlShort(kind: "sinks" | "sources" | "modules"): PactlShortEntry[] {
  const result = runCommand("pactl", ["list", "short", kind]);

  if (!result.ok) return [];

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((raw) => {
      const cols = raw.split("\t");
      return {
        index: cols[0] || "",
        name: cols[1] || "",
        raw,
      };
    });
}

function findSinkByName(name: string): PactlShortEntry | null {
  const sinks = listPactlShort("sinks");
  return sinks.find((entry) => entry.name === name) || null;
}

function findSourceByName(name: string): PactlShortEntry | null {
  const sources = listPactlShort("sources");
  return sources.find((entry) => entry.name === name) || null;
}

function getMonitorSourceNameForSink(sinkName: string): string | null {
  return findSourceByName(`${sinkName}.monitor`)?.name || null;
}

function createLinuxNullSink(
  sinkName: string,
  description: string
): boolean {
  const result = runCommand("pactl", [
    "load-module",
    "module-null-sink",
    `sink_name=${sinkName}`,
    `sink_properties=device.description=${description}`,
    "rate=48000",
    "channels=2",
  ]);

  if (!result.ok) {
    console.error("❌ Impossible de créer le sink virtuel Linux.");
    if (result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
    if (result.error) {
      console.error(result.error);
    }
    return false;
  }

  console.log(
    `✅ Sink virtuel Linux créé : ${sinkName} (module ${result.stdout.trim() || "?"})`
  );

  return true;
}

async function ensureLinuxAudioReady(): Promise<boolean> {
  if (!pactlAvailable()) {
    setRuntimeAudioRouting({
      audioDevice: null,
      virtualSinkName: null,
      virtualMonitorSource: null,
      degraded: true,
      message:
        "pactl / pipewire-pulse / PulseAudio n'est pas disponible. Impossible de créer l'entrée audio virtuelle Linux automatiquement.",
    });

    return false;
  }

  const sinkName = AUDIO_CONFIG.linuxVirtualSinkName;
  const description = AUDIO_CONFIG.linuxVirtualSinkDescription;

  let sink = findSinkByName(sinkName);

  if (!sink) {
    const created = AUDIO_CONFIG.linuxEnableVirtualSink && createLinuxNullSink(sinkName, description);
    if (!created) {
      setRuntimeAudioRouting({
        audioDevice: null,
        virtualSinkName: null,
        virtualMonitorSource: null,
        degraded: true,
        message:
          "Le sink virtuel Linux est absent. Active sa création automatique ou crée le sink configuré avant la lecture.",
      });

      return false;
    }

    sink = findSinkByName(sinkName);
  }

  if (!sink) {
    setRuntimeAudioRouting({
      audioDevice: null,
      virtualSinkName: null,
      virtualMonitorSource: null,
      degraded: true,
      message:
        "Le sink virtuel Linux a été demandé, mais reste introuvable après création.",
    });

    return false;
  }

  const monitorSource = getMonitorSourceNameForSink(sinkName);
  if (!monitorSource) {
    setRuntimeAudioRouting({
      audioDevice: null,
      virtualSinkName: sinkName,
      virtualMonitorSource: null,
      degraded: true,
      message: `La source d'entrée ${sinkName}.monitor est absente. La lecture reste bloquée.`,
    });
    return false;
  }

  setRuntimeAudioRouting({
    audioDevice: `pulse/${sinkName}`,
    virtualSinkName: sinkName,
    virtualMonitorSource: monitorSource,
    degraded: false,
    message: `Audio virtuel Linux prêt. Sink="${sinkName}" | Source d'entrée="${monitorSource}"`,
  });

  return true;
}

/* ------------------------------------------------ */
/* PUBLIC API                                       */
/* ------------------------------------------------ */

async function prepareAudioRouting(): Promise<boolean> {
  runtimeAudioRouting = {
    audioDevice: null,
    virtualSinkName: null,
    virtualMonitorSource: null,
    degraded: false,
    message: null,
  };

  if (APP_CONFIG.isWindows) {
    return ensureWindowsAudioReady();
  }

  if (APP_CONFIG.isLinux) {
    return ensureLinuxAudioReady();
  }

  setRuntimeAudioRouting({
    audioDevice: null,
    virtualSinkName: null,
    virtualMonitorSource: null,
    degraded: true,
    message:
      "Cette plateforme ne dispose pas de routage audio virtuel configuré. La lecture reste bloquée.",
  });

  return false;
}

let routingTask: Promise<boolean> | null = null;

export function ensureAudioRoutingReady(): Promise<boolean> {
  // Concurrent requests must not create several sinks or log in to the native
  // VoiceMeeter API simultaneously.
  if (!routingTask) {
    routingTask = prepareAudioRouting().finally(() => { routingTask = null; });
  }
  return routingTask;
}
