import { useState, useEffect } from "react";
import { PauseCircle, Repeat, Loader2, Music, ExternalLink } from "lucide-react";
import type { Now } from "../types";
import SpectrumBars from "./SpectrumBars";
import GlitchText from "./GlitchText";
import VideoPreview from "./VideoPreview";
import type { ThemeName } from "../lib/themes";
import { getThemeUi } from "../lib/theme-ui";

interface Props {
  now: Now | null;
  paused: boolean;
  repeat: boolean;
  busy: string | null;
  rainbow?: boolean;
  theme: ThemeName;
  spectrumHeightPx?: number;
  spectrumBars?: number;
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

export default function NowPlaying({
  now,
  paused,
  repeat,
  busy,
  rainbow = false,
  theme,
  spectrumHeightPx = 72,
  spectrumBars = 32,
}: Props) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (paused || !now?.startedAt || now?.isBuffering) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [paused, now?.startedAt, now?.isBuffering]);

  const isBuffering = Boolean(now?.isBuffering);
  const isBusy = Boolean(busy);

  const hasRealTitle =
    now?.title &&
    now.title !== "Analyse du signal..." &&
    now.title !== "Initialisation du flux..." &&
    now.title !== "Envoi au serveur...";

  const calculatePos = () => {
    if (!now) return 0;
    if (isBuffering || paused || !now.startedAt) {
      return now.positionOffsetSec || 0;
    }
    const elapsedSinceStart = (Date.now() - now.startedAt) / 1000;
    return elapsedSinceStart;
  };

  const hasDur = !!now?.durationSec && now.durationSec > 0;
  const dur = hasDur ? now!.durationSec! : 0;
  const currentPos = calculatePos();
  const pos = hasDur ? Math.min(dur, Math.max(0, currentPos)) : Math.max(0, currentPos);

  const ui = getThemeUi({ theme, rainbow });

  const { isAdventurer, isPremium, isRetrowave } = ui;

  const cardCls = [
    "relative overflow-hidden border border-transparent p-4 shadow-soft transition-all duration-500",
    isAdventurer ? "organic-panel" : "rounded-xl bg-bg/80 backdrop-blur-xl",
    rainbow ? "neon-glow rainbow-border rainbow-cycle" : "neon-glow themed-border",
  ].join(" ");

  const playingGlow =
    !paused && !isBuffering && now?.url
      ? "ring-2 ring-[var(--c1)]/40 shadow-lg shadow-[var(--c1)]/20"
      : "";

  return (
    <section className={cardCls} aria-label="Lecture en cours">
      {now?.thumb && (isPremium || rainbow) && (
        <div
          className={`absolute inset-0 opacity-20 blur-3xl scale-110 bg-center bg-cover ${
            rainbow ? "rainbow-cycle-slow" : ""
          }`}
          style={{ backgroundImage: `url(${now.thumb})` }}
        />
      )}

      <div className="relative z-10">
        <h2
          className={`text-lg mb-4 text-center uppercase tracking-widest opacity-70 ${
            isAdventurer ? "font-semibold" : "font-bold"
          } ${rainbow ? "rainbow-cycle" : ""}`}
        >
          Lecture en cours
        </h2>

        {now?.url ? (
          <div
            className={`p-3 backdrop-blur-sm ${
              isAdventurer ? "organic-panel-soft" : "rounded-xl bg-panel/50"
            } ${rainbow ? "rainbow-cycle" : ""}`}
          >
            <div className="flex flex-col md:flex-row gap-6 items-center justify-center text-center md:text-left">
              <div className="relative shrink-0">
                {now.thumb ? (
                  <img
                    src={now.thumb}
                    alt={now.title || "cover"}
                    className={`w-56 h-56 object-cover border transition-all duration-700 ${
                      isAdventurer ? "rounded-[28px] border-[#d5c5a1]/20" : "rounded-lg border-slate-700"
                    } ${playingGlow} ${isBuffering ? "grayscale blur-sm scale-95" : "scale-100"} ${
                      rainbow ? "rainbow-cycle" : ""
                    }`}
                  />
                ) : (
                  <div
                    className={`w-56 h-56 flex items-center justify-center border ${
                      isAdventurer
                        ? "rounded-[28px] border-[#d5c5a1]/20 bg-black/20"
                        : "rounded-lg border-white/5 bg-black/20"
                    } ${rainbow ? "rainbow-cycle" : ""}`}
                  >
                    <Music className={`opacity-20 w-12 h-12 ${rainbow ? "rainbow-cycle" : ""}`} />
                  </div>
                )}

                {isBuffering && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Loader2 className={`w-12 h-12 text-white animate-spin ${rainbow ? "rainbow-cycle" : ""}`} />
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0 flex flex-col items-center md:items-start justify-center">
                <div
                  className={`text-xl leading-tight line-clamp-2 min-h-[3.5rem] ${
                    isAdventurer ? "font-semibold" : "font-black italic uppercase"
                  } ${rainbow ? "rainbow-cycle" : ""}`}
                >
                  {hasRealTitle ? (
                    isRetrowave ? (
                      <GlitchText active>{now.title!}</GlitchText>
                    ) : (
                      now.title
                    )
                  ) : isBuffering ? (
                    "Initialisation du flux..."
                  ) : (
                    "Analyse du signal..."
                  )}
                </div>

                <a
                  href={now.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex items-center gap-1.5 mt-1 mb-3 text-[10px] opacity-40 hover:opacity-100 transition-opacity max-w-full group ${
                    rainbow ? "rainbow-cycle" : ""
                  }`}
                >
                  <span
                    className={`truncate group-hover:underline ${
                      isAdventurer ? "font-medium" : "font-mono"
                    }`}
                  >
                    {now.url}
                  </span>
                  <ExternalLink size={10} className="shrink-0" />
                </a>

                <div
                  className={`text-2xl font-bold ${isAdventurer ? "" : "font-mono"} ${
                    rainbow ? "rainbow-cycle" : ""
                  }`}
                  style={{ color: "var(--c1)" }}
                >
                  {isBuffering && !hasDur
                    ? "--:-- / --:--"
                    : hasDur
                    ? `${formatTime(pos)} / ${formatTime(dur)}`
                    : "LIVE / ∞"}
                </div>

                <div className="mt-4 flex flex-wrap justify-center md:justify-start items-center gap-2">
                  {paused && (
                    <span className={`px-3 py-1 text-[10px] font-bold bg-purple-600 text-white rounded-full flex items-center gap-1 shadow-lg shadow-purple-600/20 ${rainbow ? "rainbow-cycle" : ""}`}>
                      <PauseCircle size={14} /> EN PAUSE
                    </span>
                  )}
                  {repeat && (
                    <span className={`px-3 py-1 text-[10px] font-bold bg-amber-500 text-black rounded-full flex items-center gap-1 shadow-lg shadow-amber-500/20 ${rainbow ? "rainbow-cycle" : ""}`}>
                      <Repeat size={14} /> REPEAT
                    </span>
                  )}
                  {isBuffering && (
                    <span className={`px-3 py-1 text-[10px] font-bold bg-sky-600 text-white rounded-full flex items-center gap-1 animate-pulse ${rainbow ? "rainbow-cycle" : ""}`}>
                      <Loader2 size={14} className="animate-spin" /> CHARGEMENT
                    </span>
                  )}
                  {isBusy && !isBuffering && (
                    <span className={`px-3 py-1 text-[10px] font-bold bg-slate-700 text-white rounded-full flex items-center gap-1 ${rainbow ? "rainbow-cycle" : ""}`}>
                      <Loader2 size={14} className="animate-spin" /> SYNC
                    </span>
                  )}
                </div>

                <div
                  className={`mt-6 hidden md:flex items-end transition-opacity duration-500 w-full ${
                    isBuffering || paused ? "opacity-20 grayscale" : "opacity-100"
                  } ${rainbow ? "rainbow-cycle" : ""}`}
                  style={{ height: `${spectrumHeightPx}px` }}
                >
                <SpectrumBars
                  playing={!paused && !isBuffering}
                  bars={spectrumBars}
                />
                </div>
              </div>
            </div>

            <div
              className={`mt-6 md:hidden transition-opacity duration-500 w-full ${
                isBuffering || paused ? "opacity-20 grayscale" : "opacity-100"
              } ${rainbow ? "rainbow-cycle" : ""}`}
              style={{ height: `${spectrumHeightPx}px` }}
            >
            <SpectrumBars
              playing={!paused && !isBuffering}
              bars={spectrumBars}
            />
            </div>

            <VideoPreview url={now.url} rainbow={rainbow} />
          </div>
        ) : (
          <div
            className={`py-20 text-center uppercase tracking-widest border-2 border-dashed rounded-xl ${
              isAdventurer
                ? "text-[#d8d0bb]/70 border-[#d5c5a1]/15"
                : "text-muted border-white/5 font-mono animate-pulse"
            } ${rainbow ? "rainbow-cycle" : ""}`}
          >
            Aucun signal détecté
          </div>
        )}
      </div>
    </section>
  );
}
