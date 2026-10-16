import { AnimatePresence, motion } from "motion/react";
import { EyeOff, Eye } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn";

type SectionCardProps = {
  id: string;
  title: string;
  icon: ReactNode;
  isCollapsed: boolean;
  onCollapse: () => void;
  children: ReactNode;
  className?: string;
  rainbow?: boolean;
};

export default function SectionCard({
  title,
  icon,
  isCollapsed,
  onCollapse,
  children,
  className = "",
  rainbow = false,
}: SectionCardProps) {
  return (
    <AnimatePresence initial={false}>
      {!isCollapsed && (
        <motion.section
          layout
          initial={{ opacity: 0, y: 14, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.975 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className={cn("min-w-0", className, rainbow && "rainbow-cycle")}
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={cn(
                  "w-10 h-10 rounded-full border border-white/10 bg-white/5 flex items-center justify-center shrink-0",
                  rainbow && "rainbow-cycle"
                )}
              >
                <span className="opacity-85">{icon}</span>
              </div>

              <div className={cn("min-w-0", rainbow && "rainbow-cycle")}>
                <h2 className="font-semibold tracking-wide truncate">{title}</h2>
                <div className="text-xs text-white/35">Section active</div>
              </div>
            </div>

            <button
              onClick={onCollapse}
              className={cn(
                "themed-ghost-button p-2.5 shrink-0 text-white/70 hover:text-white",
                rainbow && "rainbow-cycle"
              )}
              title="Réduire la section"
              aria-label={`Réduire ${title}`}
              type="button"
            >
              <EyeOff className="w-4 h-4" />
            </button>
          </div>

          {children}
        </motion.section>
      )}
    </AnimatePresence>
  );
}

type SectionTabProps = {
  title: string;
  icon: ReactNode;
  onOpen: () => void;
  rainbow?: boolean;
};

export function SectionTab({
  title,
  icon,
  onOpen,
  rainbow = false,
}: SectionTabProps) {
  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.96 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      onClick={onOpen}
      className={cn(
        "themed-ghost-button inline-flex items-center gap-2.5 px-3.5 py-2.5 backdrop-blur-md text-white/80",
        rainbow && "rainbow-cycle"
      )}
      title={`Ouvrir ${title}`}
      aria-label={`Ouvrir ${title}`}
      type="button"
    >
      <span className="shrink-0 opacity-85">{icon}</span>
      <span className="text-sm font-medium">{title}</span>
      <Eye className="w-4 h-4 opacity-70 shrink-0" />
    </motion.button>
  );
}
