import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "onClick"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  pending?: boolean;
};

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, pending = false, disabled, className, ...props }, ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      onClick={() => onCheckedChange(!checked)}
      className={cn("inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-1 text-xs text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-not-allowed disabled:opacity-50", className)}
    >
      <span aria-hidden="true" className={cn("inline-flex h-6 w-11 items-center rounded-full border p-0.5", checked ? "border-signal bg-signal" : "border-dim bg-raised")}>
        <span className={cn("h-4 w-4 rounded-full transition-transform duration-150 motion-reduce:transition-none", checked ? "translate-x-5 bg-ink" : "translate-x-0 bg-text")} />
      </span>
      <span aria-hidden="true">{pending ? "Updating…" : checked ? "On" : "Off"}</span>
    </button>
  );
});
