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

  vm.connect();

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const virtualInputs = [3, 4];

  virtualInputs.forEach((index) => {
    vm.setStripParameter(index, "A1" as any, 1);
    vm.setStripParameter(index, "B2" as any, 1);
    vm.setStripParameter(index, "Gain" as any, 0);
  });

  console.log("✅ VoiceMeeter : A1 et B2 configurés avec succès.");

  await new Promise((resolve) => setTimeout(resolve, 500));
  vm.disconnect();
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
        "VoiceMeeter introuvable. Le bot démarre quand même, mais utilisera la sortie audio système par défaut.",
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
        "VoiceMeeter a échoué à s'initialiser. Le bot démarre quand même avec la sortie audio système par défaut.",
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
  const exact = `${sinkName}.monitor`;

  const exactMatch = findSourceByName(exact);
  if (exactMatch) return exactMatch.name;

  const sources = listPactlShort("sources");
  const fuzzy = sources.find((entry) => entry.name.includes(exact));

  return fuzzy?.name || null;
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
  if (!AUDIO_CONFIG.linuxEnableVirtualSink) {
    setRuntimeAudioRouting({
      audioDevice: null,
      virtualSinkName: null,
      virtualMonitorSource: null,
      degraded: false,
      message:
        "Création automatique du sink virtuel Linux désactivée. MPV utilisera la sortie audio par défaut.",
    });

    return true;
  }

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
    const created = createLinuxNullSink(sinkName, description);
    if (!created) {
      setRuntimeAudioRouting({
        audioDevice: null,
        virtualSinkName: null,
        virtualMonitorSource: null,
        degraded: true,
        message:
          "Le sink virtuel Linux n'a pas pu être créé. Le bot utilisera la sortie audio par défaut.",
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

  const monitorSource =
    getMonitorSourceNameForSink(sinkName) || `${sinkName}.monitor`;

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

export async function ensureAudioRoutingReady(): Promise<boolean> {
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
    degraded: false,
    message:
      "Plateforme sans routage audio virtuel dédié. MPV utilisera la sortie audio par défaut.",
  });

  return true;
}
