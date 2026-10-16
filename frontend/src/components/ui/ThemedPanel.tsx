import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { ThemeName } from "../../lib/themes";

type Props = {
  children: ReactNode;
  theme: ThemeName;
  rainbow?: boolean;
  className?: string;
  soft?: boolean;
  noBorder?: boolean;
};

export default function ThemedPanel({
  children,
  theme,
  rainbow = false,
  className = "",
  soft = false,
  noBorder = false,
}: Props) {
  const isAdventurer = !rainbow && theme === "adventurer";

  return (
    <div
      className={cn(
        !noBorder && "border",
        soft
          ? isAdventurer
            ? "organic-panel-soft themed-soft-surface-border"
            : "rounded-[var(--ui-card-radius)] bg-panel themed-soft-surface-border"
          : isAdventurer
          ? "organic-panel themed-surface-border"
          : "rounded-[var(--ui-panel-radius)] bg-bg/80 backdrop-blur-xl themed-surface-border",
        rainbow && "rainbow-cycle",
        className
      )}
    >
      {children}
    </div>
  );
}
