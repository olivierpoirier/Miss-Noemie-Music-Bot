import { History, Plus, Grip, Clock3 } from "lucide-react";

import type { QueueItem } from "../types";
import type { ThemeName } from "../lib/themes";
import { cn } from "../lib/cn";
import ThemedPanel from "./ui/ThemedPanel";

type Props = {
  items: QueueItem[];
  theme: ThemeName;
  rainbow?: boolean;
  onReAdd: (id: string) => void;
};

export default function HistoryList({
  items,
  theme,
  rainbow = false,
  onReAdd,
}: Props) {
  const isAdventurer = !rainbow && theme === "adventurer";

  return (
    <ThemedPanel
      theme={theme}
      rainbow={rainbow}
      className="p-4 flex flex-col h-[320px] md:h-[360px]"
    >
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <History className={cn("w-4 h-4 opacity-80", rainbow && "rainbow-cycle")} />
        <span className={cn("font-semibold", rainbow && "rainbow-cycle")}>
          Musiques précédentes
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scroll">
        <div className="flex flex-col gap-2">
          {items.length > 0 ? (
            items.map((item) => (
              <ThemedPanel
                key={item.id}
                theme={theme}
                rainbow={rainbow}
                soft
                className={cn(
                  "group p-2 flex items-center gap-3 cursor-grab active:cursor-grabbing",
                  isAdventurer && "rounded-[var(--ui-card-radius)]"
                )}
              >
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData(
                      "application/x-xmb-history-item",
                      JSON.stringify({ id: item.id })
                    );
                  }}
                  className="flex items-center gap-3 w-full"
                >
                  <div className="shrink-0 opacity-50">
                    <Grip className={cn("w-4 h-4", rainbow && "rainbow-cycle")} />
                  </div>

                  {item.thumb ? (
                    <img
                      src={item.thumb}
                      alt=""
                      className={cn(
                        "w-10 h-10 object-cover shrink-0",
                        isAdventurer
                          ? "rounded-[18px] border border-[#d5c5a1]/20"
                          : "rounded-[18px] border border-slate-700",
                        rainbow && "rainbow-cycle"
                      )}
                      onError={(e) => {
                        e.currentTarget.src = "/fallback-cover.png";
                      }}
                    />
                  ) : (
                    <div
                      className={cn(
                        "w-10 h-10 shrink-0 flex items-center justify-center",
                        isAdventurer
                          ? "rounded-[18px] border border-[#d5c5a1]/20 bg-black/20"
                          : "rounded-[18px] border border-slate-700 bg-black/20",
                        rainbow && "rainbow-cycle"
                      )}
                    >
                      <Clock3
                        className={cn("w-4 h-4 opacity-40", rainbow && "rainbow-cycle")}
                      />
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        "truncate text-sm text-white",
                        rainbow && "rainbow-cycle"
                      )}
                    >
                      {item.title || item.url}
                    </div>

                    <div
                      className={cn(
                        "text-[11px] truncate",
                        isAdventurer ? "text-[#d8d0bb]/65" : "text-muted",
                        rainbow && "rainbow-cycle"
                      )}
                    >
                      {item.addedBy || "anonyme"}
                      {item.durationSec ? ` · ${formatTime(item.durationSec)}` : ""}
                    </div>
                  </div>

                  <button
                    onClick={() => onReAdd(item.id)}
                    className={cn(
                      "p-2 rounded-full shrink-0 themed-secondary-button",
                      rainbow && "rainbow-cycle"
                    )}
                    title="Réajouter à la file"
                    type="button"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </ThemedPanel>
            ))
          ) : (
            <div
              className={cn(
                "text-center py-10 text-sm border border-dashed rounded-xl",
                isAdventurer
                  ? "text-[#d8d0bb]/60 border-[#d5c5a1]/15"
                  : "text-muted border-slate-700/60",
                rainbow && "rainbow-cycle"
              )}
            >
              Aucune musique précédente.
            </div>
          )}
        </div>
      </div>
    </ThemedPanel>
  );
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
