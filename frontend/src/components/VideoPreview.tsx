import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, MonitorPlay } from "lucide-react";

import { getVideoEmbed } from "../lib/embed";
import { IS_VERCEL_DEMO } from "../lib/runtime";

type Props = {
  url?: string | null;
  rainbow?: boolean;
};

const STORAGE_KEY = "xmb_video_preview_enabled";

export default function VideoPreview({ url, rainbow = false }: Props) {
  const embed = useMemo(
    () =>
      getVideoEmbed(url, {
        autoplay: !IS_VERCEL_DEMO,
        muted: true,
      }),
    [url]
  );
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    try {
      setEnabled(localStorage.getItem(STORAGE_KEY) === "true");
    } catch {
      // The preview simply stays disabled if this browser blocks storage.
    }
  }, []);

  if (!embed) return null;

  const toggle = () => {
    setEnabled((current) => {
      const next = !current;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Keep the current-session preference even if it cannot be persisted.
      }
      return next;
    });
  };

  return (
    <section
      className={`mt-5 overflow-hidden rounded-xl border border-white/10 bg-black/20 ${
        rainbow ? "rainbow-cycle" : ""
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-white/5">
        <div className="flex items-center gap-2 text-sm text-white/80">
          <MonitorPlay size={16} className="text-[var(--c1)]" />
          <span>Apercu {embed.label}</span>
          <span className="text-xs text-white/40">
            {IS_VERCEL_DEMO
              ? "demo visuelle seulement"
              : "audio du navigateur coupe"}
          </span>
        </div>

        <button
          type="button"
          onClick={toggle}
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/10 hover:text-white"
          aria-pressed={enabled}
        >
          {enabled ? <EyeOff size={15} /> : <Eye size={15} />}
          {enabled ? "Masquer la video" : "Voir la video"}
        </button>
      </div>

      {enabled && (
        <div className="aspect-video bg-black">
          <iframe
            key={embed.src}
            className="h-full w-full"
            src={embed.src}
            title={`Apercu ${embed.label}`}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      )}
    </section>
  );
}
