import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ThemeName } from "../../lib/themes";

type FieldLabelProps = {
  children: ReactNode;
  icon?: LucideIcon;
  theme: ThemeName;
  rainbow?: boolean;
  htmlFor?: string;
  className?: string;
};

export default function FieldLabel({
  children,
  icon: Icon,
  theme,
  rainbow = false,
  htmlFor,
  className,
}: FieldLabelProps) {
  const isAdventurer = !rainbow && theme === "adventurer";

  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        "mb-1.5 ml-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.2em]",
        isAdventurer ? "font-semibold text-[#dbe9cf]/70" : "font-mono text-white/40",
        rainbow && "rainbow-cycle",
        className
      )}
    >
      {Icon && (
        <Icon
          size={12}
          className={rainbow ? "animate-hue text-pink-500" : "text-[var(--c1)]"}
          aria-hidden="true"
        />
      )}
      {children}
    </label>
  );
}
