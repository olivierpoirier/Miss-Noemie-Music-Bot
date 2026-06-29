import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Music2, ListMusic, History, Info } from "lucide-react";

import AppHeader from "./components/AppHeader";
import AppFooter from "./components/AppFooter";
import FormInputs from "./components/FormInputs";
import NowPlaying from "./components/NowPlaying";
import QueueList from "./components/QueueList";
import Toast from "./components/Toast";
import PlayerBar from "./components/PlayerBar";
import ThemeDock from "./components/ThemeDock";
import ThemeScene from "./components/ThemeScene";
import SystemAlert from "./components/SystemAlert";
import DemoAudioNotice from "./components/DemoAudioNotice";

import SectionCard, { SectionTab } from "./components/SectionCard";
import HistoryList from "./components/HistoryList";
import SupportedLinksHelp from "./components/SupportedLinksHelp";

import useLiveQueue from "./hooks/useLiveQueue";
import { pickUrlLike } from "./lib/api";
import { IS_VERCEL_DEMO } from "./lib/runtime";
import {
  type ThemeName,
  type ThemeMode,
  THEME_ORDER,
  isThemeName,
} from "./lib/themes";
import type { Now, QueueItem, Control } from "./types";

type Command =
  | "pause"
  | "resume"
  | "skip"
  | "skip_group"
  | "shuffle_queue"
  | "previous"
  | "repeat"
  | "random_mode"
  | "audio_profile"
  | "seek"
  | "seek_abs";

type CollapsedSections = {
  nowPlaying: boolean;
  queue: boolean;
  history: boolean;
  help: boolean;
};

export default function App() {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");

  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem("xmb_theme_mode");
      return stored === "rainbow" || stored === "color" ? stored : "color";
    } catch (err) {
      console.warn("Impossible de lire xmb_theme_mode", err);
      return "color";
    }
  });

  const [theme, setTheme] = useState<ThemeName>(() => {
    try {
      const stored = localStorage.getItem("xmb_theme");
      return stored && isThemeName(stored) ? stored : "retrowave";
    } catch (err) {
      console.warn("Impossible de lire xmb_theme", err);
      return "retrowave";
    }
  });

  const [collapsed, setCollapsed] = useState<CollapsedSections>(() => ({
    nowPlaying: false,
    queue: false,
    history: false,
    help: true,
  }));

  const [themeTransitioning, setThemeTransitioning] = useState(false);
  const transitionTimeoutRef = useRef<number | null>(null);

  
  const {
    state,
    toast,
    setToast,
    systemError,
    play,
    command,
    busy,
    clear,
    setBusy,
    reorderQueue,
    removeQueueItem,
    requeueHistoryItem,
  } = useLiveQueue();

  useEffect(() => {
    try {
      localStorage.setItem("xmb_theme_mode", mode);
    } catch (err) {
      console.warn(err);
    }
  }, [mode]);

  useEffect(() => {
    try {
      localStorage.setItem("xmb_theme", theme);
    } catch (err) {
      console.warn(err);
    }
  }, [theme]);

  useEffect(() => {
    try {
      const n = localStorage.getItem("xmb_name");
      if (n) setName(n);
    } catch (err) {
      console.warn(err);
      setToast("Impossible de charger ton nom sauvegardé.");
    }
  }, [setToast]);

  useEffect(() => {
    try {
      localStorage.setItem("xmb_name", name || "");
    } catch (err) {
      console.warn(err);
    }
  }, [name]);

  useEffect(() => {
    return () => {
      if (transitionTimeoutRef.current) {
        window.clearTimeout(transitionTimeoutRef.current);
      }
    };
  }, []);

  const pasteInto = useCallback(
    async (setter: (s: string) => void, transform?: (s: string) => string) => {
      try {
        const text = await navigator.clipboard.readText();
        setter(transform ? transform(text) : text);
        setToast("Collé depuis le presse-papiers ✅");
      } catch (err) {
        console.warn("Clipboard inaccessible", err);
        setToast("Impossible de lire le presse-papiers.");
      }
    },
    [setToast]
  );

  const addToQueue = useCallback(() => {
    try {
      const raw = url.trim();
      if (!raw) {
        setToast("Entrée vide ❌");
        return;
      }

      const urlCandidate = pickUrlLike(raw);
      const looksLikeUrl = /^https?:\/\//i.test(urlCandidate);
      const finalInput = looksLikeUrl ? urlCandidate : raw;

      if (looksLikeUrl && !/^https?:\/\//i.test(finalInput)) {
        setToast("URL invalide ❌");
        return;
      }

      play(finalInput, name.trim() || "anon");
      setUrl("");
    } catch (err) {
      console.error("Erreur addToQueue", err);
      setToast("Impossible d’ajouter le lien.");
    }
  }, [url, name, play, setToast]);

  const sendCommand = useCallback(
    (cmd: Command, arg?: number | string) => {
      try {
        command(cmd, arg);
        window.setTimeout(() => setBusy(null), 4000);
      } catch (err) {
        console.error(`Commande échouée (${cmd})`, err);
        setBusy(null);
        setToast(`Commande échouée: ${cmd}`);
      }
    },
    [command, setBusy, setToast]
  );

  const clearWithPass = useCallback(() => {
    try {
      clear();
    } catch (err) {
      console.error("Erreur clear queue", err);
      setToast("Impossible de vider la file.");
    }
  }, [clear, setToast]);

  const collapseSection = useCallback((key: keyof CollapsedSections) => {
    setCollapsed((prev) => ({ ...prev, [key]: true }));
  }, []);

  const openSection = useCallback((key: keyof CollapsedSections) => {
    setCollapsed((prev) => ({ ...prev, [key]: false }));
  }, []);

  const switchThemeSmooth = useCallback(
    (nextMode: ThemeMode, nextTheme?: ThemeName) => {
      setThemeTransitioning(true);

      if (transitionTimeoutRef.current) {
        window.clearTimeout(transitionTimeoutRef.current);
      }

      window.setTimeout(() => {
        if (nextMode === "rainbow") {
          setMode("rainbow");
        } else if (nextTheme) {
          setTheme(nextTheme);
          setMode("color");
        }

        transitionTimeoutRef.current = window.setTimeout(() => {
          setThemeTransitioning(false);
        }, 280);
      }, 220);
    },
    []
  );

  const pickRainbow = useCallback(() => {
    switchThemeSmooth("rainbow");
  }, [switchThemeSmooth]);

  const pickNextColor = useCallback(() => {
    try {
      const currentIndex = THEME_ORDER.indexOf(theme);
      const next =
        THEME_ORDER[(currentIndex + 1) % THEME_ORDER.length] ?? "retrowave";
      switchThemeSmooth("color", next);
    } catch (err) {
      console.error("Erreur changement de thème", err);
      setToast("Impossible de changer le thème.");
    }
  }, [theme, setToast, switchThemeSmooth]);

  const control: Control = state.control ?? {
    paused: false,
    skipSeq: 0,
    repeat: false,
  };

  const randomMode = Boolean(control.randomMode);

  const paused = Boolean(control.paused);
  const repeat = Boolean(control.repeat);
  const audioProfile = control.audioProfile ?? "balanced";
  const now: Now | null = state.now ?? null;
  const queue: QueueItem[] = state.queue ?? [];
  const history: QueueItem[] = state.history ?? [];

  const rainbow = mode === "rainbow";

  const rootThemeClass = useMemo(
    () => (rainbow ? "theme-rainbow" : `theme-${theme}`),
    [rainbow, theme]
  );

  return (
    <div
      className={`min-h-screen bg-bg text-ink ${rootThemeClass} pb-28 relative overflow-hidden`}
    >
      <ThemeScene
        theme={theme}
        rainbow={rainbow}
        coverUrl={state.now?.thumb ?? null}
      />

      <div className="relative z-10">
        <SystemAlert
          isOpen={Boolean(systemError)}
          message={systemError}
          rainbow={rainbow}
        />

        <AppHeader
          theme={theme}
          rainbow={rainbow}
          onPickRainbow={pickRainbow}
          onNextColor={pickNextColor}
        />

        {toast && (
          <Toast
            message={toast}
            clear={() => setToast("")}
            rainbow={rainbow}
          />
        )}

        {IS_VERCEL_DEMO && (
          <div className="max-w-7xl mx-auto px-4 md:px-6 pt-6">
            <DemoAudioNotice theme={theme} rainbow={rainbow} />
          </div>
        )}

        <main className="max-w-7xl mx-auto px-4 md:px-6 py-6">
          <div className="mb-4 flex flex-wrap gap-2">
            {collapsed.nowPlaying && (
              <SectionTab
                title="Lecture"
                icon={<Music2 className="w-4 h-4" />}
                onOpen={() => openSection("nowPlaying")}
                rainbow={rainbow}
              />
            )}

            {collapsed.queue && (
              <SectionTab
                title="File"
                icon={<ListMusic className="w-4 h-4" />}
                onOpen={() => openSection("queue")}
                rainbow={rainbow}
              />
            )}

            {collapsed.history && (
              <SectionTab
                title="Précédentes"
                icon={<History className="w-4 h-4" />}
                onOpen={() => openSection("history")}
                rainbow={rainbow}
              />
            )}

            {collapsed.help && (
              <SectionTab
                title="Aide"
                icon={<Info className="w-4 h-4" />}
                onOpen={() => openSection("help")}
                rainbow={rainbow}
              />
            )}
          </div>

          <FormInputs
            url={url}
            setUrl={setUrl}
            name={name}
            setName={setName}
            addToQueue={addToQueue}
            pasteInto={pasteInto}
            busy={busy}
            rainbow={rainbow}
            theme={theme}
          />

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mt-4 items-start">
            <div className="xl:col-span-2 flex flex-col gap-4 min-w-0">
              <SectionCard
                id="now"
                title="Lecture en cours"
                icon={<Music2 className="w-4 h-4" />}
                isCollapsed={collapsed.nowPlaying}
                onCollapse={() => collapseSection("nowPlaying")}
                className="min-w-0"
                rainbow={rainbow}
              >
                <NowPlaying
                  now={now}
                  paused={paused}
                  repeat={repeat}
                  busy={busy}
                  rainbow={rainbow}
                  theme={theme}
                />
              </SectionCard>

              <SectionCard
                id="history"
                title="Musiques précédentes"
                icon={<History className="w-4 h-4" />}
                isCollapsed={collapsed.history}
                onCollapse={() => collapseSection("history")}
                className="min-w-0"
                rainbow={rainbow}
              >
                <HistoryList
                  items={history}
                  theme={theme}
                  rainbow={rainbow}
                  onReAdd={(id) => requeueHistoryItem(id)}
                />
              </SectionCard>

              <SectionCard
                id="help"
                title="Quels liens vers des audios que ce bot peut utiliser ?"
                icon={<Info className="w-4 h-4" />}
                isCollapsed={collapsed.help}
                onCollapse={() => collapseSection("help")}
                className="min-w-0"
                rainbow={rainbow}
              >
                <SupportedLinksHelp theme={theme} rainbow={rainbow} />
              </SectionCard>
            </div>

            <div className="xl:sticky xl:top-24 min-w-0">
              <SectionCard
                id="queue"
                title="File d’attente"
                icon={<ListMusic className="w-4 h-4" />}
                isCollapsed={collapsed.queue}
                onCollapse={() => collapseSection("queue")}
                className="min-w-0"
                rainbow={rainbow}
              >
              <QueueList
                queue={queue}
                busy={busy}
                randomMode={randomMode}
                rainbow={rainbow}
                theme={theme}
                onSkipGroup={() => sendCommand("skip_group")}
                onClear={clearWithPass}
                onShuffle={() => sendCommand("shuffle_queue")}
                onToggleRandom={() => sendCommand("random_mode", randomMode ? 0 : 1)}
                onReorder={reorderQueue}
                onRemove={removeQueueItem}
                onDropHistoryItem={(id, targetIndex) =>
                  requeueHistoryItem(id, targetIndex)
                }
              />
              </SectionCard>
            </div>
          </div>

          <AppFooter rainbow={rainbow} />
        </main>

        <ThemeDock
          value={theme}
          mode={mode}
          onPick={(m, t) => {
            switchThemeSmooth(m, t);
          }}
        />

        <PlayerBar
          now={now}
          paused={paused}
          repeat={repeat}
          randomMode={randomMode}
          audioProfile={audioProfile}
          busy={busy}
          rainbow={rainbow}
          theme={theme}
          sendCommand={sendCommand}
        />
      </div>

      <div
        className={`pointer-events-none fixed inset-0 z-[9998] bg-black transition-opacity duration-300 ${
          themeTransitioning ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  );
}
