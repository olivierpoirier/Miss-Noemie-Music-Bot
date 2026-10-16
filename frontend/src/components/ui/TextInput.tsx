import type { InputHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ThemeName } from "../../lib/themes";

type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  theme: ThemeName;
  rainbow?: boolean;
  icon?: LucideIcon;
  rightSlot?: ReactNode;
  containerClassName?: string;
  inputClassName?: string;
  scanlines?: boolean;
};

export default function TextInput({
  theme,
  rainbow = false,
  icon: Icon,
  rightSlot,
  containerClassName,
  inputClassName,
  scanlines,
  className,
  ...props
}: TextInputProps) {
  const isAdventurer = !rainbow && theme === "adventurer";
  const isPremium = !rainbow && theme === "premium";
  const hasRightSlot = rightSlot != null;

  return (
    <div
      className={cn(
        "relative min-h-[64px] overflow-hidden rounded-full transition-all duration-300",
        rainbow ? "rainbow-control-border rainbow-cycle" : "themed-control-border",
        containerClassName
      )}
    >
      {Icon && (
        <Icon
          className="pointer-events-none absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-white/35"
          aria-hidden="true"
        />
      )}
      <input
        {...props}
        className={cn(
          "relative z-[1] min-h-[64px] w-full border-none bg-transparent px-5 py-3 text-white placeholder:text-white/20 ring-0 focus:outline-none",
          Icon && "pl-11",
          hasRightSlot && "pr-12",
          isAdventurer ? "font-medium tracking-wide" : "font-mono text-sm",
          isPremium && "text-[15px]",
          rainbow && "rainbow-cycle",
          inputClassName,
          className
        )}
      />
      {hasRightSlot && (
        <div className="absolute right-3 top-1/2 z-10 -translate-y-1/2">
          {rightSlot}
        </div>
      )}
      {scanlines && !isAdventurer && (
        <div className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[length:100%_4px] opacity-[0.03]" />
      )}
    </div>
  );
}
