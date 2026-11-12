import "dotenv/config";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Explicit output layout is essential: mpv can accept a graph, fail its
// negotiation afterwards, and silently continue with the original music.
export const STEREO_CHECK_GRAPH =
  "aeval=exprs='if(between(n/s,1,5)*lt(mod(n/s-1,1),0.7),0.3*sin(2*PI*440*n/s),0)|if(between(n/s,9,13)*lt(mod(n/s-9,1),0.7),0.3*sin(2*PI*440*n/s),0)':channel_layout=stereo," +
  "alimiter=level_in=1:level_out=1:limit=0.891251:attack=4:release=80:level=false:latency=true," +
  "aformat=channel_layouts=stereo";

type Filter = { name: string; enabled?: boolean; params?: { graph?: string } };
type Reply = { request_id?: number; error?: string; data?: unknown; event?: string; text?: string };
type PulseEntry = { index: number; name?: string; sink?: number; properties?: Record<string, string> };
type Session = {
  request: (command: unknown[]) => Promise<unknown>;
  close: () => void;
  onEvent?: (message: Reply) => void;
  onFailure?: (error: Error) => void;
};

const HELP = `Test stéréo du bot — Linux / PulseAudio ou PipeWire

Sans option : cette aide, sans connexion ni lecture.
  --dry-run         Vérifier uniquement le lecteur et sa route audio.
  --prepare-stream  Ouvrir sa fenêtre « Music Bot - Audio stereo » pour Go Live.
  --play            Remplacer temporairement la musique par les bips, puis restaurer les filtres.
  --pid <nombre>    Choisir le PID si plusieurs lecteurs du bot sont actifs.
  --help            Afficher cette aide.

Exemples : npm run check:stereo -- --dry-run
           npm run check:stereo -- --prepare-stream
           npm run check:stereo -- --play

--prepare-stream seul ne joue rien; --dry-run interdit aussi toute modification de fenêtre.
Avec --play : casque à volume modéré; quatre bips à gauche, puis quatre à droite.
Ne change pas de piste ou de profil pendant les 16,5 secondes du test.
La file, le routage, le volume et le compte Discord restent inchangés.
Le résultat local ne garantit pas la stéréo reçue sur Xbox/Discord.
Windows n'est pas pris en charge par cet outil de diagnostic.
`;

function parseArgs(args: string[]) {
  const options = { help: false, dryRun: false, play: false, prepare: false, pid: undefined as number | undefined };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help": case "-h": options.help = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--play": options.play = true; break;
      case "--prepare-stream": options.prepare = true; break;
      case "--pid": {
        const value = args[++i];
        if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
          throw new Error("--pid exige un identifiant de processus positif.");
        }
        options.pid = Number(value);
        break;
      }
      default: throw new Error(`Option inconnue : ${args[i]}. Utilise --help.`);
    }
  }
  if (options.play && options.dryRun) throw new Error("Choisis --dry-run ou --play.");
  return options;
}

async function connect(socketPath: string): Promise<Session> {
  const socket = net.createConnection(socketPath);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let buffer = "";
  let disconnected = false;
  const fail = () => {
    if (disconnected) return;
    disconnected = true;
    const error = new Error("Connexion au lecteur interrompue.");
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    session.onFailure?.(error);
  };
  const session: Session = {
    request(command) {
      return new Promise((resolve, reject) => {
        if (disconnected || socket.destroyed) return reject(new Error("Lecteur déconnecté."));
        const requestId = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("Délai IPC du lecteur dépassé (2 s)."));
        }, 2_000);
        pending.set(requestId, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        socket.write(JSON.stringify({ command, request_id: requestId }) + "\n", (error) => {
          if (error) fail();
        });
      });
    },
    close() { socket.destroy(); },
  };
  socket.setEncoding("utf8");
  socket.on("error", fail);
  socket.on("close", fail);
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1_048_576) { fail(); socket.destroy(); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: Reply;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.request_id != null) {
        const waiter = pending.get(message.request_id);
        if (waiter) {
          pending.delete(message.request_id);
          if (message.error === "success") waiter.resolve(message.data);
          else waiter.reject(new Error(`Commande MPV refusée (${message.error || "erreur"}).`));
        }
      } else if (message.event) session.onEvent?.(message);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Connexion IPC indisponible.")), 1_000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new Error("Connexion IPC indisponible.")); });
    });
    return session;
  } catch (error) { session.close(); throw error; }
}

function pulseList(kind: "sinks" | "sink-inputs"): PulseEntry[] {
  const result = spawnSync("pactl", ["--format=json", "list", kind], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 1_048_576,
  });
  if (result.status !== 0) throw new Error("pactl est indisponible : impossible de vérifier la route du bot.");
  try {
    const entries = JSON.parse(result.stdout);
    if (Array.isArray(entries)) return entries;
  } catch {}
  throw new Error("Réponse pactl invalide : aucune modification autorisée.");
}

async function findTarget(pid?: number) {
  const sinkName = process.env.LINUX_VIRTUAL_SINK_NAME?.trim() || "xmbot_sink";
  const sink = pulseList("sinks").find((entry) => entry.name === sinkName);
  if (!sink) throw new Error(`Sink du bot absent : ${sinkName}. Démarre d'abord le backend et une piste.`);
  const inputs = pulseList("sink-inputs");
  const candidates: { session: Session; pid: number; socketPath: string }[] = [];
  const directory = os.tmpdir();
  const deadline = Date.now() + 10_000;
  try {
    for (const name of fs.readdirSync(directory).filter((entry) => /^xmb_mpv_[a-f0-9]+\.sock$/.test(entry))) {
      if (Date.now() >= deadline) throw new Error("Recherche des lecteurs interrompue après 10 secondes. Précise --pid et ferme les anciens lecteurs.");
      const socketPath = path.join(directory, name);
      let stat;
      try { stat = fs.lstatSync(socketPath); } catch { continue; }
      if (!stat.isSocket() || stat.uid !== process.getuid?.()) continue;
      let session: Session | undefined;
      try {
        session = await connect(socketPath);
        const processId = await session.request(["get_property", "pid"]);
        const device = await session.request(["get_property", "audio-device"]);
        const active = await session.request(["get_property", "idle-active"]);
        if (typeof processId !== "number" || !Number.isSafeInteger(processId) || (pid != null && processId !== pid) ||
            device !== `pulse/${sinkName}` || active !== false ||
            !inputs.some((input) => Number(input.sink) === Number(sink.index) && Number(input.properties?.["application.process.id"]) === processId)) {
          session.close();
          continue;
        }
        candidates.push({ session, pid: processId, socketPath });
      } catch { session?.close(); }
    }
    if (candidates.length !== 1) {
      throw new Error(candidates.length
        ? "Plusieurs lecteurs du bot sont actifs : précise --pid. Aucun lecteur modifié."
        : "Aucun lecteur actif ne correspond au PID et au sink du bot. Lance une piste, puis réessaie.");
    }
    return { ...candidates[0], sinkName };
  } catch (error) {
    for (const candidate of candidates) candidate.session.close();
    throw error;
  }
}

function hasProbe(filters: unknown): boolean {
  return Array.isArray(filters) && filters.some((filter: Filter) =>
    filter.name === "lavfi" && filter.enabled !== false && filter.params?.graph === STEREO_CHECK_GRAPH);
}

async function playProbe(session: Session) {
  if (await session.request(["get_property", "pause"])) throw new Error("Le lecteur est en pause : reprends la piste avant --play.");
  if (await session.request(["get_property", "paused-for-cache"])) throw new Error("La piste charge encore : attends la fin du chargement.");
  const saved = await session.request(["get_property", "af"]);
  if (!Array.isArray(saved)) throw new Error("Impossible de sauvegarder les filtres natifs du lecteur.");
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Test interrompu; restauration des filtres."));
  const abort = (error: Error) => controller.abort(error);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  session.onFailure = abort;
  session.onEvent = (message) => {
    if (message.event === "log-message" && /disabling filter|failed to configure|cannot select channel layout|unknown channel layouts/i.test(message.text || "")) {
      abort(new Error("MPV a refusé ou désactivé le filtre. Le test ne prouve aucune séparation stéréo."));
    }
    if (["end-file", "start-file", "shutdown"].includes(message.event || "")) abort(new Error("La piste a changé ou s'est terminée pendant le test."));
  };
  let applied = false;
  try {
    await session.request(["request_log_messages", "warn"]);
    // Restore even if MPV applies the command but its acknowledgement is lost.
    applied = true;
    await session.request(["set_property", "af", [{ name: "lavfi", enabled: true, params: { graph: STEREO_CHECK_GRAPH } }]]);
    console.log("Casque à volume modéré : quatre bips à GAUCHE (secondes 1–5), puis quatre à DROITE (9–13).");
    console.log("Ne change pas de piste ou de profil. Les filtres d'origine seront restaurés.");
    const start = Date.now();
    let phase = 0;
    while (Date.now() - start < 16_500) {
      controller.signal.throwIfAborted();
      if (!hasProbe(await session.request(["get_property", "af"]))) {
        throw new Error("Le filtre de test est absent ou désactivé. Test annulé.");
      }
      if (await session.request(["get_property", "pause"])) throw new Error("La lecture a été mise en pause pendant le test.");
      const elapsed = Date.now() - start;
      const nextPhase = elapsed >= 13_000 ? 4 : elapsed >= 9_000 ? 3 : elapsed >= 5_000 ? 2 : elapsed >= 1_000 ? 1 : 0;
      if (phase !== nextPhase) {
        console.log(["", "Phase gauche.", "Silence entre les deux séries.", "Phase droite.", "Fin des bips; restauration imminente."][nextPhase]);
        phase = nextPhase;
      }
      await delay(250, undefined, { signal: controller.signal });
    }
    console.log("Bips terminés. Vérifie les deux séries depuis l'appareil récepteur; deux canaux locaux ne suffisent pas.");
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    session.onEvent = undefined;
    session.onFailure = undefined;
    try {
      if (applied) {
        await session.request(["set_property", "af", saved]);
        console.log("Filtres d'origine restaurés.");
      }
    } catch {
      throw new Error("ÉCHEC de restauration des filtres : réapplique le profil audio depuis le lecteur du bot.");
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

async function prepareStreamWindow(session: Session) {
  await session.request(["set_property", "geometry", "640x360"]);
  await session.request(["set_property", "force-window", "immediate"]);
  const deadline = Date.now() + 3_000;
  while (await session.request(["get_property", "vo-configured"]) !== true) {
    if (Date.now() >= deadline) throw new Error("La fenêtre MPV n'est pas prête : préparation du partage interrompue.");
    await delay(50);
  }
  // Reopening a closed VO can leave its native title empty while the title
  // option still has the old value. Change it after VO creation so mpv must
  // publish a fresh title even when the final text matches the previous one.
  await session.request(["set_property", "title", "Music Bot - Préparation du partage"]);
  await session.request(["set_property", "title", "Music Bot - Audio stereo"]);
}

export async function runStereoCheck(args: string[]) {
  const options = parseArgs(args);
  if (options.help || (!options.play && !options.prepare && !options.dryRun)) { console.log(HELP); return; }
  if (process.platform !== "linux") throw new Error("Ce diagnostic nécessite Linux et pactl; Windows n'est pas pris en charge.");
  const target = await findTarget(options.pid);
  try {
    console.log(`Cible vérifiée : MPV PID ${target.pid}, sink ${target.sinkName}, socket ${target.socketPath}.`);
    if (options.dryRun) { console.log("Vérification seule : aucun son joué, aucun réglage modifié."); return; }
    if (options.prepare) {
      await prepareStreamWindow(target.session);
      console.log("Fenêtre préparée. Partage cette application avec son audio dans Discord; aucun partage n'a été lancé automatiquement.");
    }
    if (options.play) await playProbe(target.session);
  } finally { target.session.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStereoCheck(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Diagnostic stéréo impossible.");
    process.exitCode = 1;
  });
}
