import type { ClipboardEvent, KeyboardEvent } from "react";
import {
  ClipboardPaste,
  Link2,
  Music2,
  PlusCircle,
  Search,
  User,
  Youtube,
} from "lucide-react";
import { pickUrlLike } from "../lib/api";
import type { ThemeName } from "../lib/themes";
import { Button, FieldLabel, TextInput } from "./ui";

interface Props {
  url: string;
  setUrl: (s: string) => void;
  name: string;
  setName: (s: string) => void;
  addToQueue: () => void;
  pasteInto: (
    setter: (s: string) => void,
    transform?: (s: string) => string
  ) => void;
  busy: string | null;
  rainbow?: boolean;
  theme: ThemeName;
}

export default function FormInputs({
  url,
  setUrl,
  name,
  setName,
  addToQueue,
  pasteInto,
  busy,
  rainbow = false,
  theme,
}: Props) {
  const isAdventurer = !rainbow && theme === "adventurer";
  const trimmedUrl = url.trim();

  const sourceHint = (() => {
    const candidate = pickUrlLike(trimmedUrl);
    const lowered = candidate.toLowerCase();

    if (!trimmedUrl) {
      return {
        label: "En attente",
        detail: "Colle un lien ou écris un titre.",
        icon: Link2,
        tone: "text-white/45",
      };
    }

    if (lowered.includes("open.spotify.com") || lowered.startsWith("spotify:")) {
      return {
        label: "Spotify",
        detail: "Le backend trouvera le meilleur audio.",
        icon: Music2,
        tone: "text-emerald-200",
      };
    }

    if (lowered.includes("youtube.com") || lowered.includes("youtu.be")) {
      return {
        label: "YouTube",
        detail: "Lecture directe optimisée audio.",
        icon: Youtube,
        tone: "text-red-200",
      };
    }

    if (
      lowered.includes("soundcloud.com") ||
      lowered.includes("snd.sc") ||
      lowered.includes("soundcloud.app.goo.gl")
    ) {
      return {
        label: "SoundCloud",
        detail: "Fallback YouTube si le direct bloque.",
        icon: Music2,
        tone: "text-orange-200",
      };
    }

    if (/^https?:\/\//i.test(candidate)) {
      return {
        label: "Lien web",
        detail: "Le serveur va tenter de l'analyser.",
        icon: Link2,
        tone: "text-sky-200",
      };
    }

    return {
      label: "Recherche",
      detail: "Recherche texte côté serveur.",
      icon: Search,
      tone: "text-violet-200",
    };
  })();

  const SourceHintIcon = sourceHint.icon;

  const handlePasteUrl = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData?.getData("text") || "";
    if (text) {
      e.preventDefault();
      setUrl(pickUrlLike(text));
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!busy && trimmedUrl) {
        addToQueue();
      }
    }
  };

  const isButtonDisabled = !!busy || !trimmedUrl;
  const submitLabel = busy === "play"
    ? "Syncing..."
    : trimmedUrl
    ? "Transmit"
    : "Signal requis";
  const submitVariant = trimmedUrl || busy === "play" ? "primary" : "secondary";

  return (
    <div
      className={`mb-8 grid grid-cols-1 gap-4 p-1 sm:grid-cols-2 md:gap-6 2xl:grid-cols-[minmax(0,1fr),minmax(240px,0.65fr),minmax(170px,auto)] ${
        rainbow ? "rainbow-cycle" : ""
      }`}
    >
      <div className="flex flex-col">
        <FieldLabel theme={theme} rainbow={rainbow} icon={Link2} htmlFor="source-signal">
          Source Signal
        </FieldLabel>

        <TextInput
          id="source-signal"
          theme={theme}
          rainbow={rainbow}
          placeholder="Spotify, YouTube, SoundCloud ou recherche"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={handlePasteUrl}
          onKeyDown={handleKeyDown}
          autoComplete="url"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="source-status"
          scanlines
        />

        <div
          id="source-status"
          className={`mt-2 min-h-[20px] flex items-center gap-2 text-xs ${
            isAdventurer ? "text-[#e7efd9]/65" : "text-white/50"
          } ${rainbow ? "rainbow-cycle" : ""}`}
        >
          <span className={`inline-flex items-center gap-1.5 ${sourceHint.tone}`}>
            <SourceHintIcon className="w-3.5 h-3.5" />
            <span className="font-medium">{sourceHint.label}</span>
          </span>
          <span className="truncate">{sourceHint.detail}</span>
        </div>

        <Button
          onClick={() => pasteInto(setUrl, pickUrlLike)}
          disabled={!!busy}
          icon={ClipboardPaste}
          size="xs"
          rainbow={rainbow}
          className={`mt-2 ${isAdventurer ? "rounded-full" : "font-mono uppercase tracking-wider"}`}
        >
          Auto-Link
        </Button>
      </div>

      <div className="flex flex-col">
        <FieldLabel theme={theme} rainbow={rainbow} icon={User} htmlFor="operator-id">
          Operator ID
        </FieldLabel>

        <TextInput
          id="operator-id"
          theme={theme}
          rainbow={rainbow}
          placeholder="Guest_01 optionnel"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          autoComplete="nickname"
          aria-describedby="operator-status"
          scanlines
        />

        <div
          id="operator-status"
          className={`mt-2 min-h-[20px] text-xs ${
            isAdventurer ? "text-[#e7efd9]/65" : "text-white/50"
          } ${rainbow ? "rainbow-cycle" : ""}`}
        >
          {name.trim() ? `Ajouté par ${name.trim()}` : "Sans nom, ce sera ajouté par anon."}
        </div>

        <Button
          onClick={() => pasteInto(setName)}
          disabled={!!busy}
          icon={ClipboardPaste}
          size="xs"
          rainbow={rainbow}
          className={`mt-2 ${isAdventurer ? "rounded-full" : "font-mono uppercase tracking-wider"}`}
        >
          Recall ID
        </Button>
      </div>

      <div className="flex min-w-0 flex-col justify-end sm:col-span-2 2xl:col-span-1">
        <Button
          onClick={addToQueue}
          disabled={isButtonDisabled}
          title={isButtonDisabled ? submitLabel : "Ajouter à la file"}
          icon={PlusCircle}
          loading={busy === "play"}
          variant={submitVariant}
          size="lg"
          rainbow={rainbow}
          className={`h-[48px] w-full min-w-0 2xl:min-w-[170px] ${
            isAdventurer ? "rounded-full font-semibold" : "rounded-full font-mono"
          }`}
        >
          {submitLabel}
        </Button>

        <div className="h-[30px] hidden lg:block" />
      </div>
    </div>
  );
}
