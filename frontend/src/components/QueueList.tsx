import React from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Trash2, GripVertical, ListMusic, Shuffle } from "lucide-react";

import type { QueueItem } from "../types";
import type { ThemeName } from "../lib/themes";
import { cn } from "../lib/cn";
import ThemedPanel from "./ui/ThemedPanel";

interface Props {
  queue: QueueItem[];
  busy: string | null;
  randomMode: boolean;
  onSkipGroup: () => void;
  onClear: () => void;
  onShuffle: () => void;
  onToggleRandom: () => void;
  onReorder: (ids: string[]) => void;
  onRemove: (id: string) => void;
  onDropHistoryItem?: (id: string, targetIndex?: number) => void;
  rainbow?: boolean;
  theme: ThemeName;
}

function SortableQueueItem({
  item,
  index,
  disabled,
  onRemove,
  onDropHistoryItem,
  theme,
  rainbow = false,
}: {
  item: QueueItem;
  index: number;
  disabled: boolean;
  onRemove: (id: string) => void;
  onDropHistoryItem?: (id: string, targetIndex?: number) => void;
  theme: ThemeName;
  rainbow?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: disabled || item.status === "pending" });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : "auto",
  };

  const displayName = item.title || item.url;
  const isAdventurer = !rainbow && theme === "adventurer";
  const isPending = item.status === "pending";

  return (
    <ThemedPanel
      theme={theme}
      rainbow={rainbow}
      soft
      className={cn(
        "group p-2 flex gap-3 items-center touch-manipulation relative w-full overflow-hidden",
        isAdventurer ? "rounded-[22px]" : "",
        isPending && "opacity-70"
      )}
    >
      <div
        ref={setNodeRef}
        style={style}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-xmb-history-item")) {
            e.preventDefault();
          }
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData("application/x-xmb-history-item");
          if (!raw || disabled || isPending) return;
          e.preventDefault();
          e.stopPropagation();

          try {
            const data: unknown = JSON.parse(raw);
            if (data && typeof data === "object" && "id" in data && typeof data.id === "string") {
              onDropHistoryItem?.(data.id, index);
            }
          } catch (err) {
            console.warn("Drop history item invalide", err);
          }
        }}
        className="flex gap-3 items-center w-full"
      >
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          disabled={disabled || isPending}
          className={cn(
            "cursor-grab active:cursor-grabbing text-muted hover:text-white shrink-0 touch-none",
            rainbow && "rainbow-cycle"
          )}
          title="Déplacer"
          type="button"
        >
          <GripVertical className="w-5 h-5" />
        </button>

        {item.thumb ? (
          <img
            src={item.thumb}
            alt=""
            className={cn(
              "w-10 h-10 object-cover border shrink-0",
              isAdventurer
                ? "rounded-xl border-[#d5c5a1]/20"
                : "rounded border-slate-700",
              rainbow && "rainbow-cycle"
            )}
          />
        ) : (
          <div
            className={cn(
              "w-10 h-10 shrink-0 border flex items-center justify-center",
              isAdventurer
                ? "rounded-xl border-[#d5c5a1]/20 bg-black/20"
                : "rounded border-slate-700 bg-black/20",
              rainbow && "rainbow-cycle"
            )}
          >
            <ListMusic className="w-4 h-4 opacity-40" />
          </div>
        )}

        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="marquee-container">
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              onPointerDown={(e) => e.stopPropagation()}
              className={cn(
                "text-white hover:text-blue-400 font-medium text-sm block",
                rainbow && "rainbow-cycle",
                isPending && "pointer-events-none"
              )}
            >
              <span className="marquee-content will-change-transform">
                {displayName}
                <span className="hidden group-hover:inline group-active:inline ml-8 opacity-40">
                  {displayName}
                </span>
              </span>
            </a>
          </div>

          <div
            className={cn(
              "text-[11px] truncate",
              isAdventurer ? "text-[#d8d0bb]/65" : "text-muted",
              rainbow && "rainbow-cycle"
            )}
          >
            {item.addedBy || "anonyme"} · {isPending ? "envoi..." : item.status}
          </div>
        </div>

        <button
          disabled={disabled || isPending}
          onClick={() => onRemove(item.id)}
          className={cn(
            "p-2 shrink-0 rounded-lg transition themed-danger-button",
            rainbow && "rainbow-cycle"
          )}
          title="Retirer de la file"
          type="button"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </ThemedPanel>
  );
}

export default function QueueList({
  queue,
  busy,
  randomMode,
  onSkipGroup,
  onClear,
  onShuffle,
  onToggleRandom,
  onReorder,
  onRemove,
  onDropHistoryItem,
  rainbow = false,
  theme,
}: Props) {
  const isBusy = Boolean(busy);
  const isAdventurer = !rainbow && theme === "adventurer";

  const sensors = useSensors(
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    useSensor(PointerSensor, {
      activationConstraint: { distance: 10 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 8,
      },
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (isBusy || !over || active.id === over.id) return;

    const queuedItems = queue.filter((q) => q.status !== "pending");
    const oldIndex = queuedItems.findIndex((q) => q.id === active.id);
    const newIndex = queuedItems.findIndex((q) => q.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const newOrder = arrayMove(queuedItems, oldIndex, newIndex);
    onReorder(newOrder.map((q) => q.id));
  };

  return (
    <ThemedPanel
      theme={theme}
      rainbow={rainbow}
      className="p-4 flex flex-col h-[420px] md:h-[70vh]"
    >
      <section
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-xmb-history-item")) {
            e.preventDefault();
          }
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData("application/x-xmb-history-item");
          if (!raw || isBusy) return;
          e.preventDefault();
          e.stopPropagation();

          try {
            const data: unknown = JSON.parse(raw);
            if (data && typeof data === "object" && "id" in data && typeof data.id === "string") {
              onDropHistoryItem?.(data.id);
            }
          } catch (err) {
            console.warn("Drop history item invalide", err);
          }
        }}
        className="flex flex-col h-full"
      >
        <div className="flex items-center justify-between mb-4 shrink-0 gap-3">
          <h2
            className={cn(
              "font-semibold",
              isAdventurer && "tracking-wide",
              rainbow && "rainbow-cycle"
            )}
          >
            File d&apos;attente
          </h2>

          <div className="flex gap-2 flex-wrap justify-end">
            <button
              onClick={onShuffle}
              className={cn(
                "text-xs px-3 py-2 rounded-lg themed-secondary-button inline-flex items-center gap-2",
                rainbow && "rainbow-cycle"
              )}
              title="Mélanger la file"
              type="button"
            >
              <Shuffle className="w-3.5 h-3.5" />
              Shuffle
            </button>

            <button
              onClick={onToggleRandom}
              className={cn(
                "text-xs px-3 py-2 rounded-lg border transition inline-flex items-center gap-2",
                randomMode
                  ? "border-[var(--c1)] text-[var(--c1)] bg-[color-mix(in_oklab,var(--c1)_10%,transparent)]"
                  : "border-white/10 bg-white/5 text-white/70 hover:text-white",
                rainbow && "rainbow-cycle"
              )}
              title="Mode lecture aléatoire"
              type="button"
            >
              <Shuffle className="w-3.5 h-3.5" />
              Aléatoire
            </button>

            <button
              onClick={onSkipGroup}
              className={cn(
                "text-xs px-3 py-2 rounded-lg themed-secondary-button",
                rainbow && "rainbow-cycle"
              )}
              title="Passer le groupe"
              type="button"
            >
              Skip
            </button>

            <button
              onClick={onClear}
              className={cn(
                "text-xs px-3 py-2 rounded-lg themed-danger-button",
                rainbow && "rainbow-cycle"
              )}
              title="Vider la file"
              type="button"
            >
              Vider
            </button>
          </div>
        </div>

        <div className="max-w-full overflow-hidden flex-1 min-h-0">
          <div className="h-full overflow-y-auto overflow-x-hidden pr-1 custom-scroll touch-pan-y">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={queue.map((q) => q.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-2">
                  {queue.length > 0 ? (
                    queue.map((item, index) => (
                      <SortableQueueItem
                        key={item.id}
                        item={item}
                        index={queue.slice(0, index).filter((q) => q.status !== "pending").length}
                        disabled={isBusy}
                        onRemove={onRemove}
                        onDropHistoryItem={onDropHistoryItem}
                        theme={theme}
                        rainbow={rainbow}
                      />
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
                      <div className="flex flex-col items-center gap-2">
                        <ListMusic
                          className={cn(
                            "w-5 h-5 opacity-60",
                            rainbow && "rainbow-cycle"
                          )}
                        />
                        <span>La file est vide.</span>
                        <span className="text-xs opacity-60">
                          Tu peux glisser une musique précédente ici.
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </div>
      </section>
    </ThemedPanel>
  );
}
