import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "toggle";
type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
  iconEnd?: LucideIcon;
  loading?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
  rainbow?: boolean;
  children?: ReactNode;
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: "min-h-8 px-3 py-1.5 text-[10px]",
  sm: "min-h-9 px-3 py-2 text-xs",
  md: "min-h-10 px-4 py-2 text-sm",
  lg: "min-h-12 px-8 py-3 text-sm",
  icon: "h-10 w-10 p-0",
};

const iconSizeClasses: Record<ButtonSize, string> = {
  xs: "w-3 h-3",
  sm: "w-3.5 h-3.5",
  md: "w-4 h-4",
  lg: "w-[18px] h-[18px]",
  icon: "w-4 h-4",
};

function variantClasses(variant: ButtonVariant, active: boolean) {
  if (variant === "primary") {
    return "theme-active-button text-white shadow-[0_0_15px_rgba(255,255,255,0.1)] hover:scale-[1.02] active:scale-95";
  }

  if (variant === "danger") {
    return "themed-danger-button";
  }

  if (variant === "ghost") {
    return "themed-ghost-button";
  }

  if (variant === "toggle") {
    return active
      ? "themed-toggle-button themed-toggle-button-active"
      : "themed-toggle-button";
  }

  return "themed-secondary-button";
}

export default function Button({
  icon: Icon,
  iconEnd: IconEnd,
  loading = false,
  disabled = false,
  variant = "secondary",
  size = "md",
  active = false,
  rainbow = false,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const LoaderIcon = loading ? Loader2 : Icon;

  return (
    <button
      {...props}
      disabled={isDisabled}
      type={type}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center gap-2 overflow-hidden rounded-full border font-medium transition-all",
        "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_oklab,var(--c1)_24%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-35",
        variant === "primary" && "font-mono font-black uppercase tracking-tight italic",
        variantClasses(variant, active),
        sizeClasses[size],
        rainbow && "rainbow-cycle",
        className
      )}
    >
      {LoaderIcon && (
        <LoaderIcon
          className={cn(iconSizeClasses[size], loading && "animate-spin")}
          aria-hidden="true"
        />
      )}
      {children && <span className="min-w-0 truncate">{children}</span>}
      {IconEnd && !loading && (
        <IconEnd className={iconSizeClasses[size]} aria-hidden="true" />
      )}
    </button>
  );
}
