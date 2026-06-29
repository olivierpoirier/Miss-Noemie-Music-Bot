import { Info, Volume2 } from "lucide-react";

import { cn } from "../lib/cn";
import type { ThemeName } from "../lib/themes";

type Props = {
  rainbow?: boolean;
  theme: ThemeName;
};

export default function DemoAudioNotice({ rainbow = false, theme }: Props) {
  const isAdventurer = !rainbow && theme === "adventurer";

  return (
    <aside
      className={cn(
        "relative overflow-hidden border p-4 shadow-soft",
        isAdventurer ? "organic-panel-soft" : "rounded-xl bg-bg/80 backdrop-blur-xl",
        rainbow ? "rainbow-border rainbow-cycle" : "themed-border"
      )}
      aria-label="Information demo audio"
    >
      <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center border border-white/10 bg-white/5",
            isAdventurer ? "rounded-2xl" : "rounded-xl",
            rainbow && "rainbow-cycle"
          )}
        >
          <Volume2 className="h-5 w-5 text-[var(--c1)]" />
        </div>

        <div className={cn("min-w-0 flex-1", rainbow && "rainbow-cycle")}>
          <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-white/55">
            <Info className="h-3.5 w-3.5 text-[var(--c1)]" />
            Demo Vercel
          </div>
          <p className="text-sm leading-6 text-white/78">
            Le backend demo Vercel est actif: les liens, la file et les controles
            repondent comme dans l'application. L'audio reel n'est pas disponible
            ici, car la lecture locale passe normalement par mpv et une entree
            virtuelle.
          </p>
        </div>
      </div>
    </aside>
  );
}
