import { useState } from "react";
import {
  LogOut,
  Menu,
  RefreshCw,
  Settings,
  ShieldCheck,
  UserCircle,
} from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../../lib/utils";
import { FleetSidebar } from "./FleetSidebar";
import { FleetDrawer } from "./FleetDrawer";
import type { DashboardOverview, VpsRecord } from "../../lib/api";
import { BrandMark } from "../Brand";
export type LiveConnectionState =
  | { status: "connecting" }
  | { status: "live"; latestEventAt: string }
  | { status: "reconnecting"; latestEventAt?: string }
  | { status: "stale"; latestEventAt?: string };

type Props = {
  mode: "demo" | "local";
  busy: boolean;
  liveState: LiveConnectionState;
  onRefresh: () => void;
  onLogout?: () => void;
  workspaceName?: string;
  hosts: VpsRecord[];
  metrics: DashboardOverview["metrics"];
  children: ReactNode;
};

export function DashboardShell({
  mode,
  busy,
  liveState,
  onRefresh,
  onLogout,
  workspaceName,
  hosts,
  metrics,
  children,
}: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  const isVpsList = pathname === "/vps";
  const isVpsNew = pathname === "/vps/new";
  const isWorkspace = pathname.startsWith("/vps/") && !isVpsNew;

  const currentCrumb = isVpsList
    ? "Servers"
    : isVpsNew
      ? "New VPS"
      : isWorkspace
        ? (workspaceName?.trim() || "Server workspace")
        : "Dashboard";

  return (
    <main className="dashboard-root min-h-screen w-full bg-ink text-text lg:flex">
      <FleetSidebar hosts={hosts} metrics={metrics} selectedHostId={isWorkspace ? pathname.split("/")[2] : undefined} />
      <div className="min-w-0 flex-1">
      <header className="flex h-14 items-center justify-between gap-3 border-b border-line bg-ink px-4 sm:px-6">
        <nav
          aria-label="Dashboard context"
          className="flex min-w-0 flex-1 items-center gap-2 text-[13px] sm:gap-3"
        >
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open fleet navigation"
            className="inline-flex h-8 w-8 items-center justify-center border border-line bg-panel text-dim transition-colors duration-160 ease-out hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-signal lg:hidden"
          >
            <Menu size={15} aria-hidden="true" />
          </button>

          <Link
            to="/vps"
            aria-label="FlexServer — go to servers"
            className="flex shrink-0 items-center gap-2 font-semibold text-text transition-colors hover:text-dim focus-visible:outline-2 focus-visible:outline-signal"
          >
            <BrandMark />
            <span className="hidden min-[400px]:inline">FlexServer</span>
          </Link>
          <span aria-hidden="true" className="shrink-0 text-line">
            /
          </span>
          {isVpsList ? (
            <span aria-current="page" className="truncate font-medium text-text">
              Servers
            </span>
          ) : (
            <>
              <Link
                to="/vps"
                className="shrink-0 text-dim transition-colors hover:text-text"
              >
                Servers
              </Link>
              <span aria-hidden="true" className="shrink-0 text-line">
                /
              </span>
              <span
                aria-current="page"
                className="max-w-[140px] truncate font-medium text-text sm:max-w-[240px]"
              >
                {currentCrumb}
              </span>
            </>
          )}
        </nav>

        <div className="flex shrink-0 items-center gap-3 text-[12px] text-dim">
          <ModeLabel mode={mode} />
          <LiveStatus state={liveState} />
          <IconButton
            label={busy ? "Refreshing" : "Refresh dashboard"}
            disabled={busy}
            onClick={onRefresh}
          >
            <RefreshCw size={14} className={cn(busy && "animate-spin")} />
          </IconButton>
          <UserMenu onLogout={onLogout} />
        </div>
      </header>

      <div
        className={cn(
          "w-full px-4 pb-12 sm:px-6",
          isWorkspace ? "pt-5" : "pt-6",
        )}
      >
        {children}
      </div>
      </div>
      <FleetDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        hosts={hosts}
        metrics={metrics}
        selectedHostId={isWorkspace ? pathname.split("/")[2] : undefined}
      />
    </main>
  );
}

function ModeLabel({ mode }: { mode: "demo" | "local" }) {
  return (
    <span className="whitespace-nowrap text-dim max-[560px]:hidden">
      {mode === "demo" ? "Demo environment" : "Local environment"}
    </span>
  );
}

function LiveStatus({ state }: { state: LiveConnectionState }) {
  const label =
    state.status === "connecting"
      ? "Connecting"
      : state.status === "live"
        ? "Live"
        : state.status === "reconnecting"
          ? "Reconnecting"
          : "Connection stale";
  const latestEventAt = "latestEventAt" in state ? state.latestEventAt : undefined;
  const latestEvent = latestEventAt
    ? new Date(latestEventAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  return (
    <span
      role="status"
      aria-label={`Monitoring connection: ${label}`}
      title={latestEvent ? `Latest monitoring event: ${latestEvent}` : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        state.status === "live" ? "text-text" : "text-dim",
      )}
    >
      <i
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          state.status === "live"
            ? "bg-signal"
            : state.status === "connecting"
              ? "bg-warn"
              : "bg-crit",
        )}
      />
      <span className="max-[560px]:hidden">{label}</span>
    </span>
  );
}

function UserMenu({ onLogout }: { onLogout?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open local admin account menu"
          title="Local admin account"
          className="grid h-8 w-8 shrink-0 place-items-center bg-raised text-[11px] font-semibold text-text transition-colors hover:bg-raised/70 focus-visible:outline-2 focus-visible:outline-signal"
        >
          LA
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-56 border-line bg-panel text-text"
        align="end"
      >
        <DropdownMenuLabel>
          <div className="grid gap-1">
            <span>Local admin</span>
            <span className="text-xs font-normal text-dim">
              VPS operations workspace
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem disabled>
            <UserCircle size={16} />
            Profile
            <DropdownMenuShortcut>⌘P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <Settings size={16} />
            Settings
            <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <ShieldCheck size={16} />
            Security notes
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className={onLogout ? "text-text" : "text-dim"}
          onSelect={onLogout}
          disabled={!onLogout}
        >
          <LogOut size={16} />
          {onLogout ? "Log out" : "Log out unavailable"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IconButton({
  label,
  children,
  className,
  ...props
}: {
  label: string;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center border border-line text-text transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
