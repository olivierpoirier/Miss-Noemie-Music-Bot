import { AnimatePresence, motion } from "framer-motion";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  RotateCcw,
  RotateCw,
  Repeat,
  Shuffle,
  X,
  ChevronUp,
  Loader2,
  Music4,
  Disc3,
  Sparkles,
  Headphones,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import type { Now, Command, AudioProfileName } from "../types";
import type { ThemeName } from "../lib/themes";
import SpectrumBars from "./SpectrumBars";

interface Props {
  now: Now | null;
  paused: boolean;
  repeat: boolean;
  randomMode: boolean;
  audioProfile: AudioProfileName;
  busy: string | null;
  sendCommand: (cmd: Command, arg?: number | string) => void;
  rainbow?: boolean;
  theme: ThemeName;
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

export default function PlayerBar({
  now,
  paused,
  repeat,
  randomMode,
  audioProfile,
  busy,
  sendCommand,
  rainbow = false,
  theme,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [localPos, setLocalPos] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);

  const lastSeekTime = useRef<number>(0);
  const requestRef = useRef<number | null>(null);

  useEffect(() => {
    const updateTick = () => {
      const nowMs = Date.now();

      if (!isDragging && nowMs - lastSeekTime.current > 800) {
        if (!now) {
          setLocalPos(0);
        } else if (now.isBuffering || paused || !now.startedAt) {
          setLocalPos(now.positionOffsetSec || 0);
        } else {
          const elapsed = (nowMs - now.startedAt) / 1000;
          setLocalPos(elapsed);
        }
      }

      requestRef.current = requestAnimationFrame(updateTick);
    };

    requestRef.current = requestAnimationFrame(updateTick);

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [now, paused, isDragging]);

  const handleSeekEnd = (value: number) => {
    setIsDragging(false);
    setLocalPos(value);
    lastSeekTime.current = Date.now();
    sendCommand("seek_abs", value);
  };

  const isBuffering = Boolean(now?.isBuffering);
  const isBusy = Boolean(busy) || isBuffering;
  const hasDur = !!now?.durationSec && now.durationSec > 0;
  const dur = hasDur ? now!.durationSec! : 0;

  const hasRealTitle =
    now?.title &&
    now.title !== "Analyse du signal..." &&
    now.title !== "Initialisation du flux..." &&
    now.title !== "Envoi au serveur...";

  const displayTitle = hasRealTitle
    ? now!.title
    : isBuffering
    ? "INITIALISATION..."
    : "ANALYSE DU SIGNAL...";

  const subtitle = now?.addedBy ? `Ajouté par ${now.addedBy}` : "Source web";

  const currentPos = isDragging
    ? dragValue
    : hasDur
    ? Math.min(dur, Math.max(0, localPos))
    : localPos;

  const progressPct = hasDur ? (currentPos / dur) * 100 : 0;

  const isAdventurer = !rainbow && theme === "adventurer";
  const isFloral = !rainbow && theme === "floral";
  const xboxProfileOn = audioProfile === "xbox";

  const barShellCls = isAdventurer
    ? "bg-[rgba(18,24,18,0.88)] border-t border-[#d5c5a1]/10"
    : isFloral
    ? "bg-[rgba(26,18,28,0.88)] border-t border-white/10"
    : "bg-[rgba(7,9,12,0.88)] border-t border-white/10";

  return (
    <AnimatePresence>
      {now?.url && (
        <>
          <motion.div
            initial={{ y: 100 }}
            animate={{ y: 0 }}
            exit={{ y: 100 }}
            className={`fixed bottom-0 inset-x-0 z-40 h-20 backdrop-blur-2xl shadow-[0_-10px_40px_rgba(0,0,0,0.5)] ${barShellCls} ${
              rainbow ? "rainbow-cycle" : ""
            }`}
          >
            <div className="absolute top-0 left-0 right-0 h-[3px] bg-white/5 overflow-hidden">
              <motion.div
                className={
                  rainbow
                    ? "h-full bg-gradient-to-r from-cyan-400 via-violet-500 to-pink-500 rainbow-cycle"
                    : "h-full bg-[linear-gradient(90deg,var(--c1),var(--c2))]"
                }
                style={{ width: `${progressPct}%` }}
              />
            </div>

            <div className="flex items-center h-full px-4 gap-3 max-w-6xl mx-auto w-full">
              <button
                className={`relative shrink-0 w-12 h-12 overflow-hidden group shadow-lg ${
                  isAdventurer
                    ? "rounded-2xl border border-[#d5c5a1]/20"
                    : "rounded-xl border border-white/10"
                } ${rainbow ? "rainbow-cycle" : ""}`}
                onClick={() => setExpanded(true)}
                type="button"
              >
                {now.thumb ? (
                  <img
                    src={now.thumb}
                    className={`w-full h-full object-cover transition-all duration-700 ${
                      isBuffering && !hasRealTitle ? "blur-md opacity-50" : ""
                    } ${rainbow ? "rainbow-cycle" : ""}`}
                    alt=""
                  />
                ) : (
                  <div className="w-full h-full bg-white/5 flex items-center justify-center">
                    <Music4
                      className={`opacity-30 ${rainbow ? "rainbow-cycle" : ""}`}
                      size={16}
                    />
                  </div>
                )}

                <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <ChevronUp
                    className={`text-white w-6 h-6 ${rainbow ? "rainbow-cycle" : ""}`}
                  />
                </div>
              </button>

              <button
                className={`flex-1 min-w-0 text-left ${rainbow ? "rainbow-cycle" : ""}`}
                onClick={() => setExpanded(true)}
                type="button"
              >
                <div className="text-[10px] uppercase tracking-[0.18em] opacity-50 mb-0.5">
                  {subtitle}
                </div>
                <div
                  className={`text-sm font-semibold truncate ${
                    isBuffering && !hasRealTitle ? "opacity-50" : "text-white/92"
                  }`}
                >
                  {displayTitle}
                </div>
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => sendCommand(paused ? "resume" : "pause")}
                  disabled={isBusy && !paused}
                  className={`p-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition-all text-[var(--c1)] disabled:opacity-20 ${
                    rainbow ? "rainbow-cycle" : ""
                  }`}
                  type="button"
                >
                  {isBuffering && !paused ? (
                    <Loader2 size={20} className="animate-spin" />
                  ) : paused ? (
                    <Play size={20} fill="currentColor" />
                  ) : (
                    <Pause size={20} fill="currentColor" />
                  )}
                </button>

                <button
                  onClick={() => sendCommand("skip")}
                  className={`p-3 text-white/60 hover:text-white transition-colors ${
                    rainbow ? "rainbow-cycle" : ""
                  }`}
                  type="button"
                >
                  <SkipForward size={20} fill="currentColor" />
                </button>
              </div>
            </div>
          </motion.div>

          <AnimatePresence>
            {expanded && (
              <motion.div
                className={`fixed inset-0 z-50 overflow-hidden ${rainbow ? "rainbow-cycle" : ""}`}
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 30, stiffness: 220 }}
              >
                <div className="absolute inset-0 bg-[rgba(4,6,10,0.96)] backdrop-blur-3xl" />

                {now.thumb && (
                  <div
                    className={`absolute inset-0 opacity-20 blur-3xl scale-110 bg-center bg-cover ${
                      rainbow ? "rainbow-cycle-slow" : ""
                    }`}
                    style={{ backgroundImage: `url(${now.thumb})` }}
                  />
                )}

                <div
                  className={`absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_40%)] ${
                    rainbow ? "rainbow-cycle" : ""
                  }`}
                />

                <div className="relative z-10 h-full overflow-y-auto custom-scroll">
                  <div className="min-h-full max-w-5xl mx-auto px-4 md:px-8 py-6 md:py-8 flex flex-col">
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-11 h-11 rounded-2xl border border-white/10 bg-white/5 flex items-center justify-center ${
                            rainbow ? "rainbow-cycle" : ""
                          }`}
                        >
                          <Disc3 className="w-5 h-5 text-[var(--c1)]" />
                        </div>
                        <div className={rainbow ? "rainbow-cycle" : ""}>
                          <div className="text-xs uppercase tracking-[0.22em] text-white/45">
                            Lecteur
                          </div>
                          <div className="text-white/90 font-semibold">
                            Contrôles en cours
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() => setExpanded(false)}
                        className={`p-3 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 hover:text-white transition ${
                          rainbow ? "rainbow-cycle" : ""
                        }`}
                        type="button"
                      >
                        <X size={22} />
                      </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-[380px,1fr] gap-8 items-center flex-1">
                      <div className="flex flex-col items-center">
                        <div
                          className={`relative w-full max-w-[380px] aspect-square rounded-[2rem] p-2 border border-white/10 bg-white/5 shadow-2xl ${
                            rainbow ? "rainbow-cycle" : ""
                          }`}
                        >
                          {now.thumb ? (
                            <img
                              src={now.thumb}
                              className={`w-full h-full rounded-[1.5rem] object-cover transition-all duration-1000 ${
                                isBuffering && !hasRealTitle
                                  ? "blur-2xl opacity-35 scale-95"
                                  : "scale-100"
                              } ${rainbow ? "rainbow-cycle" : ""}`}
                              alt=""
                            />
                          ) : (
                            <div className="w-full h-full rounded-[1.5rem] bg-white/5 flex items-center justify-center">
                              <Music4
                                className={`w-14 h-14 opacity-20 ${rainbow ? "rainbow-cycle" : ""}`}
                              />
                            </div>
                          )}
                        </div>

                        <div
                          className={`w-full max-w-[380px] h-16 mt-5 ${rainbow ? "rainbow-cycle" : ""}`}
                        >
                          <SpectrumBars playing={!paused && !isBuffering} bars={30} />
                        </div>
                      </div>

                      <div className={`min-w-0 ${rainbow ? "rainbow-cycle" : ""}`}>
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/5 text-white/65 text-xs mb-4">
                          <Sparkles className="w-3.5 h-3.5" />
                          Lecture active
                        </div>

                        <h2 className="text-2xl md:text-4xl font-bold text-white leading-tight break-words">
                          {displayTitle}
                        </h2>

                        <p className="mt-3 text-white/55">{subtitle}</p>

                        <div
                          className={`mt-8 rounded-[1.5rem] border border-white/10 bg-white/5 p-4 md:p-5 ${
                            rainbow ? "rainbow-cycle" : ""
                          }`}
                        >
                          <div className="flex justify-between text-xs tracking-widest text-white/60 mb-3">
                            <span>{formatTime(currentPos)}</span>
                            <span>{hasDur ? formatTime(dur) : "--:--"}</span>
                          </div>

                          <div className="relative">
                            <div className="absolute inset-y-0 left-0 right-0 my-auto h-2 rounded-full bg-white/10" />
                            <div
                              className={`absolute inset-y-0 left-0 my-auto h-2 rounded-full bg-[linear-gradient(90deg,var(--c1),var(--c2))] ${
                                rainbow ? "rainbow-cycle" : ""
                              }`}
                              style={{ width: `${progressPct}%` }}
                            />

                            <input
                              type="range"
                              min={0}
                              max={Math.max(1, Math.floor(dur))}
                              value={Math.floor(currentPos)}
                              disabled={!hasDur}
                              onMouseDown={() => setIsDragging(true)}
                              onMouseUp={(e) =>
                                handleSeekEnd(
                                  parseInt((e.target as HTMLInputElement).value, 10)
                                )
                              }
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10);
                                setDragValue(val);
                                setLocalPos(val);
                              }}
                              className="themed-range relative z-10 w-full h-6 appearance-none bg-transparent cursor-pointer"
                            />
                          </div>

                          <div className="mt-6 grid grid-cols-5 gap-3 items-center">
                            <button
                              onClick={() => sendCommand("seek", -15)}
                              className={`h-14 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 text-white/75 transition flex items-center justify-center ${
                                rainbow ? "rainbow-cycle" : ""
                              }`}
                              type="button"
                            >
                              <RotateCcw size={22} />
                            </button>

                            <button
                              onClick={() => sendCommand("previous")}
                              className={`h-14 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 text-white/75 transition flex items-center justify-center ${
                                rainbow ? "rainbow-cycle" : ""
                              }`}
                              type="button"
                            >
                              <SkipBack size={22} fill="currentColor" />
                            </button>

                            <button
                              onClick={() => sendCommand(paused ? "resume" : "pause")}
                              className={`h-16 rounded-[1.25rem] border border-white/10 bg-[linear-gradient(135deg,color-mix(in_oklab,var(--c1)_22%,transparent),color-mix(in_oklab,var(--c2)_18%,transparent))] hover:brightness-110 text-white transition flex items-center justify-center ${
                                rainbow ? "rainbow-cycle" : ""
                              }`}
                              type="button"
                            >
                              {isBuffering && !paused ? (
                                <Loader2 size={28} className="animate-spin" />
                              ) : paused ? (
                                <Play fill="currentColor" size={28} className="ml-1" />
                              ) : (
                                <Pause fill="currentColor" size={28} />
                              )}
                            </button>

                            <button
                              onClick={() => sendCommand("skip")}
                              className={`h-14 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 text-white/75 transition flex items-center justify-center ${
                                rainbow ? "rainbow-cycle" : ""
                              }`}
                              type="button"
                            >
                              <SkipForward size={22} fill="currentColor" />
                            </button>

                            <button
                              onClick={() => sendCommand("seek", 15)}
                              className={`h-14 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 text-white/75 transition flex items-center justify-center ${
                                rainbow ? "rainbow-cycle" : ""
                              }`}
                              type="button"
                            >
                              <RotateCw size={22} />
                            </button>
                          </div>

                          <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
                            <div className="text-sm text-white/45">
                              {isBuffering
                                ? "Chargement du flux…"
                                : paused
                                ? "Lecture en pause"
                                : "Lecture en cours"}
                            </div>

                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <button
                                onClick={() =>
                                  sendCommand("random_mode", randomMode ? 0 : 1)
                                }
                                className={`px-4 py-2 rounded-xl border transition ${
                                  randomMode
                                    ? "border-[var(--c1)] bg-[color-mix(in_oklab,var(--c1)_15%,transparent)] text-[var(--c1)]"
                                    : "border-white/10 bg-white/5 text-white/50 hover:text-white"
                                } ${rainbow ? "rainbow-cycle" : ""}`}
                                type="button"
                              >
                                <span className="inline-flex items-center gap-2">
                                  <Shuffle size={16} />
                                  Aléatoire
                                </span>
                              </button>

                              <button
                                onClick={() => sendCommand("repeat", repeat ? 0 : 1)}
                                className={`px-4 py-2 rounded-xl border transition ${
                                  repeat
                                    ? "border-[var(--c1)] bg-[color-mix(in_oklab,var(--c1)_15%,transparent)] text-[var(--c1)]"
                                    : "border-white/10 bg-white/5 text-white/50 hover:text-white"
                                } ${rainbow ? "rainbow-cycle" : ""}`}
                                type="button"
                              >
                                <span className="inline-flex items-center gap-2">
                                  <Repeat size={16} />
                                  Repeat
                                </span>
                              </button>

                              <button
                                onClick={() =>
                                  sendCommand(
                                    "audio_profile",
                                    xboxProfileOn ? "balanced" : "xbox"
                                  )
                                }
                                className={`px-4 py-2 rounded-xl border transition ${
                                  xboxProfileOn
                                    ? "border-emerald-400 bg-emerald-400/15 text-emerald-200"
                                    : "border-white/10 bg-white/5 text-white/50 hover:text-white"
                                } ${rainbow ? "rainbow-cycle" : ""}`}
                                type="button"
                                title="Optimise le son pour le chemin micro / Xbox party"
                              >
                                <span className="inline-flex items-center gap-2">
                                  <Headphones size={16} />
                                  {xboxProfileOn ? "Xbox" : "Équilibré"}
                                </span>
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="mt-6 text-xs text-white/35">
                          Astuce : le bouton précédent relance la piste actuelle si tu as déjà avancé de quelques secondes, sinon il repart dans l’historique.
                        </div>
                      </div>
                    </div>

                    <div className="pt-8 mt-8 border-t border-white/8 text-center text-xs text-white/35">
                      XMB Music Bot · Interface joueur
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>
  );
}
