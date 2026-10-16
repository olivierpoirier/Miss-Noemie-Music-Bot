import { Activity, ChevronDown, Download, RefreshCw } from "lucide-react";
import useDiagnostics from "../hooks/useDiagnostics";
import { cn } from "../lib/cn";
import type { DiagnosticSnapshot, DiagnosticTool } from "../lib/diagnostics";
import type { ThemeName } from "../lib/themes";
import ThemedPanel from "./ui/ThemedPanel";

type Props = { theme: ThemeName; rainbow?: boolean; open: boolean; onOpenChange: (open: boolean) => void };

const toolStatus = {
  ok: "Disponible",
  warning: "À vérifier",
  error: "Indisponible",
  unchecked: "Vérification en attente",
};

const severity = { info: "Information", warn: "Avertissement", error: "Erreur" };

function dateTime(value: string): string {
  return new Date(value).toLocaleString("fr-CA");
}

function uptime(seconds: number): string {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} j ${Math.floor(seconds % 86_400 / 3_600)} h`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)} h ${Math.floor(seconds % 3_600 / 60)} min`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds)} s`;
}

function exportSnapshot(snapshot: DiagnosticSnapshot) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `xbox-music-diagnostic-${snapshot.timestamp.replace(/[:.]/g, "-")}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function ToolDetails({ name, tool }: { name: string; tool: DiagnosticTool }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{name}</h4>
        <span className={cn(
          "text-xs",
          tool.status === "error" ? "text-red-300" : tool.status === "warning" ? "text-amber-200" : "text-muted"
        )}>
          {toolStatus[tool.status]}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">Version : {tool.version || "inconnue"}</p>
      <p className="mt-2 break-all font-mono text-xs leading-5 text-muted">{tool.path || "Chemin introuvable"}</p>
      {tool.message && <p className="mt-2 text-xs leading-5">{tool.message}</p>}
      {tool.checkedAt && <p className="mt-2 text-xs text-muted">Vérifié le {dateTime(tool.checkedAt)}</p>}
    </div>
  );
}

export default function DiagnosticsPanel({ theme, rainbow = false, open, onOpenChange }: Props) {
  const { snapshot, error, loading, refresh, demo } = useDiagnostics(open);
  const player = snapshot?.player;
  const playerState = !player ? "Inconnu"
    : player.starting ? "En démarrage"
    : player.loading ? "Chargement"
    : player.buffering ? "Mise en mémoire tampon"
    : player.paused ? "En pause"
    : player.engineRunning ? "Actif" : "Arrêté";

  return (
    <ThemedPanel theme={theme} rainbow={rainbow} className="mt-6">
      <details id="bot-diagnostics" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--c1)] [&::-webkit-details-marker]:hidden">
          <Activity className="h-5 w-5 shrink-0 text-[var(--c1)]" aria-hidden="true" />
          <span className="flex-1 font-semibold">Diagnostic du bot</span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </summary>

        <div className="border-t border-white/10 p-4">
          {demo ? (
            <p className="text-sm leading-6 text-muted">
              Les diagnostics de mpv, de yt-dlp et du serveur sont disponibles dans
              l’application locale. La démo Vercel n’utilise pas ces services.
            </p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 basis-48 text-xs leading-5 text-muted" role="status">
                  {loading ? "Actualisation du diagnostic…" : snapshot
                    ? `Dernier relevé : ${dateTime(snapshot.timestamp)}`
                    : "Aucun relevé disponible."}
                  {" "}Actualisation toutes les 15 secondes quand ce panneau est visible.
                </p>
                <button
                  type="button"
                  onClick={refresh}
                  disabled={loading}
                  className="themed-secondary-button inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm disabled:cursor-wait disabled:opacity-50"
                >
                  <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} aria-hidden="true" />
                  Actualiser
                </button>
                {snapshot && (
                  <button
                    type="button"
                    onClick={() => exportSnapshot(snapshot)}
                    className="themed-secondary-button inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
                  >
                    <Download className="h-4 w-4" aria-hidden="true" />
                    Exporter JSON
                  </button>
                )}
              </div>

              {error && (
                <p role="status" className="mb-4 rounded-xl border border-amber-300/25 bg-amber-300/5 p-3 text-sm leading-6 text-amber-100">
                  {error}{snapshot && " Le dernier relevé reste affiché; ses informations peuvent avoir changé."}
                </p>
              )}

              {snapshot && (
                <>
                  <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-xl border border-white/10 p-3">
                      <dt className="text-xs text-muted">Serveur</dt>
                      <dd className="mt-1 text-sm font-medium">En ligne depuis {uptime(snapshot.server.uptimeSec)}</dd>
                      <dd className="mt-1 text-xs leading-5 text-muted">
                        {snapshot.server.activeUsers} connecté(s) · {snapshot.server.queued} en file
                      </dd>
                      <dd className="mt-1 text-xs text-muted">
                        {snapshot.server.idleShutdownMs > 0
                          ? `Arrêt après ${uptime(snapshot.server.idleShutdownMs / 1_000)} sans interface`
                          : "Arrêt automatique désactivé"}
                      </dd>
                    </div>
                    <div className="rounded-xl border border-white/10 p-3">
                      <dt className="text-xs text-muted">Lecteur mpv</dt>
                      <dd className="mt-1 text-sm font-medium">{playerState}</dd>
                      <dd className="mt-1 text-xs text-muted">{snapshot.player.retryCount} tentative(s) de reprise</dd>
                    </div>
                    <div className="rounded-xl border border-white/10 p-3">
                      <dt className="text-xs text-muted">Sortie audio</dt>
                      <dd className="mt-1 text-sm font-medium">
                        {snapshot.audioRouting.degraded ? "Mode dégradé" : snapshot.audioRouting.ready ? "Prête" : "En préparation"}
                      </dd>
                      {snapshot.audioRouting.message && <dd className="mt-1 text-xs leading-5 text-muted">{snapshot.audioRouting.message}</dd>}
                    </div>
                    <div className="rounded-xl border border-white/10 p-3">
                      <dt className="text-xs text-muted">Journal sur disque</dt>
                      <dd className="mt-1 text-sm font-medium">
                        {!snapshot.logging.enabled ? "Désactivé" : snapshot.logging.available ? "Actif" : "Indisponible"}
                      </dd>
                      {snapshot.logging.runId && <dd className="mt-1 font-mono text-xs text-muted">Session {snapshot.logging.runId.slice(0, 8)}</dd>}
                      {Boolean(snapshot.logging.droppedWrites) && (
                        <dd className="mt-1 text-xs leading-5 text-amber-200" role="status">
                          {snapshot.logging.droppedWrites} événement(s) n'ont pas pu être sauvegardés. Vérifie l'espace disque et les permissions du journal.
                        </dd>
                      )}
                      <dd className="mt-1 text-xs leading-5 text-muted">Le rapport exporté contient ce relevé et les événements récents.</dd>
                    </div>
                  </dl>

                  <h3 className="mb-3 mt-5 text-sm font-semibold">Outils réellement utilisés</h3>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <ToolDetails name="yt-dlp" tool={snapshot.tools.ytDlp} />
                    {snapshot.tools.mpv && <ToolDetails name="mpv" tool={snapshot.tools.mpv} />}
                  </div>

                  <h3 className="mb-3 mt-5 text-sm font-semibold">Événements récents</h3>
                  {snapshot.recentEvents.length === 0 ? (
                    <p className="text-sm leading-6 text-muted">Aucun événement enregistré pour le moment. Les erreurs et les reprises apparaîtront ici.</p>
                  ) : (
                    <ol className="custom-scroll max-h-80 space-y-2 overflow-y-auto" aria-label="Événements, du plus récent au plus ancien">
                      {snapshot.recentEvents.map((event, index) => (
                        <li key={`${event.timestamp}-${event.code}-${index}`} className="rounded-xl border border-white/10 p-3">
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                            <span className={event.level === "error" ? "text-red-300" : event.level === "warn" ? "text-amber-200" : "text-muted"}>{severity[event.level]}</span>
                            <time className="text-muted" dateTime={event.timestamp}>{dateTime(event.timestamp)}</time>
                            <span className="break-all font-mono text-muted">{event.category} / {event.code}</span>
                            {event.runId && (
                              <span className="text-muted">
                                Session {event.runId.slice(0, 8)}{snapshot.logging.runId && event.runId !== snapshot.logging.runId ? " (précédente)" : ""}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 break-words text-sm leading-6">{event.message}</p>
                          {event.details && (
                            <p className="mt-1 break-words text-xs leading-5 text-muted">
                              {[
                                event.details.trackId && `Piste #${event.details.trackId}`,
                                event.details.platform && `Plateforme : ${event.details.platform}`,
                                event.details.stage && `Étape : ${event.details.stage}`,
                                event.details.status !== undefined && `HTTP ${event.details.status}`,
                                event.details.exitCode !== undefined && `Code de sortie : ${event.details.exitCode}`,
                                event.details.reason && `Motif : ${event.details.reason}`,
                                event.details.attempt !== undefined && `Tentative : ${event.details.attempt}`,
                                event.details.durationMs !== undefined && `Durée : ${event.details.durationMs} ms`,
                                event.details.activeUsers !== undefined && `${event.details.activeUsers} interface(s) connectée(s)`,
                                event.details.itemCount !== undefined && `${event.details.itemCount} titre(s)`,
                                event.details.uptimeSec !== undefined && `Actif depuis ${uptime(event.details.uptimeSec)}`,
                                event.details.rssMB !== undefined && `Mémoire totale : ${event.details.rssMB} Mio`,
                                event.details.heapUsedMB !== undefined && `Mémoire JS : ${event.details.heapUsedMB} Mio`,
                                event.details.lagMs !== undefined && `Retard du serveur : ${event.details.lagMs} ms`,
                              ].filter(Boolean).join(" · ")}
                            </p>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </details>
    </ThemedPanel>
  );
}
