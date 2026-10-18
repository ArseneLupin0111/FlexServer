import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";

type RowActionsMenuProps = {
  /** Accessible identity of the row whose actions are shown. */
  label: string;
  children: ReactNode;
  disabled?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
};

/** Shared overflow trigger; callers own menu items, permissions, and sibling dialogs. */
export function RowActionsMenu({
  label,
  children,
  disabled = false,
  triggerClassName,
  contentClassName = "w-48",
}: RowActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`More actions for ${label}`}
          disabled={disabled}
          className={triggerClassName}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={contentClassName}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
