import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { AlertTriangle, CheckCircle2, ExternalLink, LogOut, RefreshCw, ShieldCheck, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VpsRecord } from "../../../lib/api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../ui/sheet";

type Status = "disabled" | "disconnected" | "verifying" | "connecting" | "connected" | "reconnecting" | "disconnecting" | "expired" | "error";
const labels: Record<Status, string> = { disabled: "Unavailable", disconnected: "Disconnected", verifying: "Verifying host", connecting: "Connecting", connected: "Connected", reconnecting: "Reconnecting", disconnecting: "Disconnecting", expired: "Session expired", error: "Connection error" };
const safeError = (message: string) => /authentication|permission|unreachable|timeout|disabled|expired|identity|host/i.test(message) ? message : "The SSH session could not be opened. Check the VPS and try again.";

type ServerMessage =
  | { type: "ready"; terminalSessionId: string; startedAt: string; expiresAt: string }
  | { type: "output"; data: string }
  | { type: "error"; code: string; message: string; retryable: boolean; closeReason?: string }
  | { type: "closed"; reason: string; exitCode?: number };

const isValidTimestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));

function parseServerMessage(raw: unknown): ServerMessage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.type !== "string") return undefined;
  if (value.type === "ready") {
    if (!hasOnly(value, ["type", "terminalSessionId", "startedAt", "expiresAt"])) return undefined;
    if (typeof value.terminalSessionId !== "string" || value.terminalSessionId.length === 0) return undefined;
    if (!isValidTimestamp(value.startedAt) || !isValidTimestamp(value.expiresAt)) return undefined;
    return value as ServerMessage;
  }
  if (value.type === "output") {
    return hasOnly(value, ["type", "data"]) && typeof value.data === "string" ? value as ServerMessage : undefined;
  }
  if (value.type === "error") {
    return hasOnly(value, ["type", "code", "message", "retryable", "closeReason"]) && typeof value.code === "string" && typeof value.message === "string" && typeof value.retryable === "boolean" && (value.closeReason === undefined || typeof value.closeReason === "string") ? value as ServerMessage : undefined;
  }
  if (value.type === "closed") {
    return hasOnly(value, ["type", "reason", "exitCode"]) && typeof value.reason === "string" && (value.exitCode === undefined || (typeof value.exitCode === "number" && Number.isFinite(value.exitCode) && Number.isInteger(value.exitCode))) ? value as ServerMessage : undefined;
  }
  return undefined;
}

const invalidResponseNotice = "The terminal received an invalid response.";
const maxTerminalInputBytes = 64 * 1024;
const clipboardUnavailableNotice = "Clipboard access is unavailable or was denied. Use the browser's copy or paste command instead.";

export function TerminalPanel({
  vps,
  enabled = true,
  isLocal: isLocalProp,
}: {
  vps: VpsRecord;
  enabled?: boolean;
  isLocal?: boolean;
}) {
  const isLocal =
    isLocalProp ?? (vps.kind === "local" || vps.managedBy === "system");
  const host = `${vps.username}@${vps.host}:${vps.port}`;
  const connectionLabel = isLocal
    ? vps.displayName || vps.name || "Local host"
    : host;
  const root = vps.username === "root";
  const [status, setStatus] = useState<Status>(enabled ? "disconnected" : "disabled");
  const [notice, setNotice] = useState("");
  const [details, setDetails] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmPaste, setConfirmPaste] = useState(false);
  const [confirmNavigation, setConfirmNavigation] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string>();
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const socketRef = useRef<WebSocket>();
  const resizeTimer = useRef<number>();
  const observerRef = useRef<ResizeObserver>();
  const expiryTimer = useRef<number>();
  const inputDisposable = useRef<{ dispose: () => void }>();
  const manualClose = useRef(false);
  // Sensitive clipboard contents deliberately live only in memory until accepted or cancelled.
  const pendingPaste = useRef("");
  const pendingLink = useRef<HTMLAnchorElement>();
  const allowNextNavigation = useRef(false);
  const active = status === "connected" || status === "connecting" || status === "verifying" || status === "reconnecting";

  const queuePaste = useCallback((text: string) => {
    if (!text) return;
    if (socketRef.current?.readyState !== 1) { setNotice("Connect the terminal before pasting."); return; }
    if (new TextEncoder().encode(text).length > maxTerminalInputBytes) { setNotice("The clipboard content is too large to paste into the terminal at once."); return; }
    if (/\r|\n/.test(text)) { pendingPaste.current = text; setConfirmPaste(true); return; }
    socketRef.current.send(JSON.stringify({ type: "input", data: text }));
  }, []);

  const disposeConnection = useCallback(() => {
    if (resizeTimer.current !== undefined) window.clearTimeout(resizeTimer.current);
    resizeTimer.current = undefined;
    if (expiryTimer.current !== undefined) window.clearTimeout(expiryTimer.current);
    expiryTimer.current = undefined;
    observerRef.current?.disconnect(); observerRef.current = undefined;
    inputDisposable.current?.dispose(); inputDisposable.current = undefined;
    pendingPaste.current = "";
    const socket = socketRef.current;
    socketRef.current = undefined;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
    fitRef.current?.dispose(); fitRef.current = undefined;
    terminalRef.current?.dispose(); terminalRef.current = undefined;
  }, []);

  const connect = useCallback((reconnect = false) => {
    if (!enabled || !mountRef.current || ["connecting", "connected", "verifying", "reconnecting"].includes(status)) return;
    disposeConnection();
    setNotice(""); setStatus(reconnect ? "reconnecting" : "verifying"); manualClose.current = false;
    const term = new Terminal({ convertEol: true, cursorBlink: true, scrollback: 5000, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", theme: { background: "#0b0d0c", foreground: "#e4e9e2", cursor: "#c6f432", cursorAccent: "#0b0d0c", selectionBackground: "#c6f432", selectionForeground: "#0b0d0c", black: "#0b0d0c", red: "#ff5a4d", green: "#c6f432", yellow: "#ffb02e", blue: "#5ec8e5", magenta: "#e4e9e2", cyan: "#5ec8e5", white: "#e4e9e2", brightBlack: "#7d877f", brightRed: "#ff5a4d", brightGreen: "#c6f432", brightYellow: "#ffb02e", brightBlue: "#5ec8e5", brightMagenta: "#e4e9e2", brightCyan: "#5ec8e5", brightWhite: "#e4e9e2" } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(mountRef.current); fit.fit();
    terminalRef.current = term; fitRef.current = fit;
    // A browser may produce both a keyboard shortcut and a paste event for one action.
    // The paste event is authoritative when present; changing this token cancels the
    // pending Clipboard API fallback before it can send the same text again.
    let pasteAttempt = 0;
    const copySelection = async () => {
      const selection = term.getSelection();
      if (!selection) { setNotice("Select terminal text before copying."); return; }
      if (window.isSecureContext === false || !navigator.clipboard?.writeText) { setNotice(clipboardUnavailableNotice); return; }
      try { await navigator.clipboard.writeText(selection); } catch { setNotice(clipboardUnavailableNotice); }
    };
    const readClipboard = async (attempt: number) => {
      if (window.isSecureContext === false || !navigator.clipboard?.readText) { setNotice(clipboardUnavailableNotice); return; }
      try { const text = await navigator.clipboard.readText(); if (attempt === pasteAttempt) queuePaste(text); } catch { if (attempt === pasteAttempt) setNotice(clipboardUnavailableNotice); }
    };
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const copyShortcut = key === "c" && ((event.ctrlKey && event.shiftKey) || event.metaKey || (event.ctrlKey && Boolean(term.getSelection())));
      const pasteShortcut = key === "v" && (event.ctrlKey || event.metaKey);
      if (copyShortcut) { void copySelection(); return false; }
      if (pasteShortcut) { const attempt = ++pasteAttempt; void readClipboard(attempt); return false; }
      return true;
    });
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/vps/${encodeURIComponent(vps.id)}/terminal`);
    socketRef.current = socket;
    const current = () => socketRef.current === socket;
    socket.onopen = () => { if (!current()) return; setStatus("connecting"); socket.send(JSON.stringify({ type: "open", version: 1, vpsId: vps.id, cols: Math.max(1, Math.min(500, term.cols)), rows: Math.max(1, Math.min(200, term.rows)) })); };
    socket.onmessage = (event) => { if (!current()) return; try { const message = parseServerMessage(JSON.parse(event.data)); if (!message) { setNotice(invalidResponseNotice); setStatus("error"); manualClose.current = true; socket.close(); return; } if (message.type === "ready") { setStatus("connected"); setExpiresAt(message.expiresAt); if (message.expiresAt) { const remaining = Math.max(0, Date.parse(message.expiresAt) - Date.now()); if (expiryTimer.current !== undefined) window.clearTimeout(expiryTimer.current); expiryTimer.current = window.setTimeout(() => { if (!current()) return; manualClose.current = true; setStatus("expired"); setNotice("This SSH session expired. Scrollback is preserved; reconnect to start a new shell."); socket.close(); }, remaining); } term.focus(); } else if (message.type === "output") term.write(message.data); else if (message.type === "error") { setNotice(safeError(message.message || "Connection failed.")); setStatus("error"); manualClose.current = true; socket.close(); } else if (message.type === "closed") { if (message.reason === "session_expired") { manualClose.current = true; setStatus("expired"); setNotice("Your dashboard session ended, so the terminal closed. Scrollback is preserved. Sign in again to start a new terminal session."); } else { setStatus(manualClose.current ? "disconnected" : "error"); if (!manualClose.current) setNotice("The SSH session closed unexpectedly. Scrollback is preserved."); } } } catch { setNotice(invalidResponseNotice); setStatus("error"); manualClose.current = true; socket.close(); } };
    socket.onerror = () => { if (!current()) return; setNotice("The SSH connection failed. Check the VPS and try again."); setStatus("error"); manualClose.current = true; socket.close(); };
    socket.onclose = () => { if (!current()) return; if (!manualClose.current) { setStatus("error"); setNotice("The SSH session closed unexpectedly. Scrollback is preserved."); } };
    inputDisposable.current = term.onData((data) => { if (current() && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data })); });
    const pasteTarget = mountRef.current;
    const onPaste = (event: ClipboardEvent) => {
      ++pasteAttempt;
      const text = event.clipboardData?.getData("text") ?? "";
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      queuePaste(text);
    };
    const onCopy = (event: ClipboardEvent) => { const selection = term.getSelection(); if (!selection || !event.clipboardData) return; event.preventDefault(); event.clipboardData.setData("text/plain", selection); };
    pasteTarget.addEventListener("paste", onPaste, true);
    pasteTarget.addEventListener("copy", onCopy, true);
    const priorDispose = inputDisposable.current;
    inputDisposable.current = { dispose: () => { pasteTarget.removeEventListener("paste", onPaste, true); pasteTarget.removeEventListener("copy", onCopy, true); priorDispose?.dispose(); } };
    const observer = new ResizeObserver(() => { if (!current()) return; if (resizeTimer.current !== undefined) window.clearTimeout(resizeTimer.current); resizeTimer.current = window.setTimeout(() => { if (!current()) return; fit.fit(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: Math.max(1, Math.min(500, term.cols)), rows: Math.max(1, Math.min(200, term.rows)) })); }, 120); });
    observer.observe(mountRef.current);
    observerRef.current = observer;
  }, [disposeConnection, enabled, queuePaste, status, vps.id]);

  const disconnect = useCallback(() => { manualClose.current = true; setStatus("disconnecting"); if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "disconnect" })); socketRef.current?.close(); setStatus("disconnected"); }, []);
  useEffect(() => () => disposeConnection(), [disposeConnection]);
  useEffect(() => { if (!enabled) { disposeConnection(); setStatus("disabled"); } }, [enabled, disposeConnection]);
  useEffect(() => {
    if (enabled && status === "disabled" && !socketRef.current) {
      setStatus("disconnected");
      setNotice("");
      setExpiresAt(undefined);
    }
  }, [enabled, status]);
  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const guardLink = (event: MouseEvent) => {
      if (allowNextNavigation.current) { allowNextNavigation.current = false; return; }
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.href === window.location.href) return;
      event.preventDefault();
      pendingLink.current = link;
      setConfirmNavigation(true);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLink, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", guardLink, true); };
  }, [active]);

  const sendPendingPaste = () => {
    const text = pendingPaste.current;
    pendingPaste.current = "";
    if (text && socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "input", data: text }));
  };

  const action = status === "connected" ? disconnect : () => connect(status === "error" || status === "expired");
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-panel p-3 sm:p-4">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><TerminalSquare size={18} className="text-dim" aria-hidden="true" /><h2 className="text-[14px] font-semibold text-text">{isLocal ? "Host terminal" : "SSH terminal"}</h2><StatusDot status={status} />{root && <span className="border border-warn/40 bg-warn/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-warn">ROOT</span>}</div><p className="tnum mt-1 truncate text-xs text-dim">{connectionLabel}</p></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setDetails(true)} aria-label="Connection details"><ExternalLink /> Details</Button>{status === "connected" && <Button size="sm" variant="outline" onClick={() => setConfirmClose(true)}><LogOut /> Disconnect</Button>}{status !== "connected" && status !== "disabled" && <Button size="sm" onClick={action} disabled={["connecting", "verifying", "reconnecting", "disconnecting"].includes(status)}>{status === "error" || status === "expired" ? <RefreshCw /> : <CheckCircle2 />} {status === "error" || status === "expired" ? "Reconnect" : "Connect"}</Button>}</div>
    </div>
    {root && <div role="alert" className="flex gap-3 border border-warn/40 bg-warn/10 p-3 text-[13px] text-warn"><AlertTriangle size={18} className="shrink-0" aria-hidden="true" /><span><strong>Root shell.</strong> Commands can change or delete data on this server. Review the host identity before connecting.</span></div>}
    {notice && <div role="alert" className="border border-crit/40 bg-crit/10 p-3 text-[13px] text-crit">{notice}</div>}
    <div className="overflow-hidden border border-line bg-ink"><div ref={mountRef} aria-label={`${isLocal ? "Host" : "SSH"} terminal for ${connectionLabel}`} role="application" tabIndex={0} className="h-[clamp(20rem,62vh,42rem)] min-h-0 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/70 sm:min-h-[28rem]" />{status === "disconnected" || status === "disabled" ? <div className="border-t border-line p-3 text-xs text-dim">{status === "disabled" ? "Web terminal is disabled for this environment." : (isLocal ? "Connect to open a new host shell. Scrollback is retained after disconnect." : "Connect to open a new SSH shell. Scrollback is retained after disconnect.")}</div> : null}</div>
    <div aria-live="polite" className="tnum flex flex-wrap justify-between gap-2 text-[11px] text-dim"><span>{labels[status]} · Ctrl+C copies selection · Paste Ctrl+V / ⌘V</span><span>{expiresAt ? `Expires ${new Date(expiresAt).toLocaleTimeString()}` : (isLocal ? "Host transport · Monitoring status is shown in the dashboard header" : "SSH transport · Monitoring status is shown in the dashboard header")}</span></div>
    <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}><AlertDialogContent className="border-line bg-panel text-text"><AlertDialogHeader><AlertDialogTitle>{isLocal ? "Close active host session?" : "Close active SSH session?"}</AlertDialogTitle><AlertDialogDescription className="text-dim">{isLocal ? "The host shell will disconnect. Running foreground commands may continue or be interrupted." : "The shell will disconnect. Running foreground commands may continue or be interrupted remotely."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep session open</AlertDialogCancel><AlertDialogAction onClick={disconnect}>Disconnect and leave</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={confirmPaste} onOpenChange={(open) => { setConfirmPaste(open); if (!open) pendingPaste.current = ""; }}><AlertDialogContent className="border-line bg-panel text-text"><AlertDialogHeader><AlertDialogTitle>Paste multiple lines?</AlertDialogTitle><AlertDialogDescription className="text-dim">Multiple lines may run several commands at once. Review the clipboard content before continuing. It is not saved by this page.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel paste</AlertDialogCancel><AlertDialogAction onClick={sendPendingPaste}>Paste into terminal</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={confirmNavigation} onOpenChange={(open) => { setConfirmNavigation(open); if (!open) pendingLink.current = undefined; }}><AlertDialogContent className="border-line bg-panel text-text"><AlertDialogHeader><AlertDialogTitle>{isLocal ? "Leave this active host session?" : "Leave this active session?"}</AlertDialogTitle><AlertDialogDescription className="text-dim">{isLocal ? "Leaving this page disconnects the host terminal session. Finish your work or disconnect first." : "Leaving this page disconnects the SSH session. Finish your work or disconnect first."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Stay here</AlertDialogCancel><AlertDialogAction onClick={() => { const link = pendingLink.current; pendingLink.current = undefined; allowNextNavigation.current = true; disconnect(); link?.click(); }}>Disconnect and leave</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <Sheet open={details} onOpenChange={setDetails}><SheetContent className="border-line bg-panel text-text"><SheetHeader><SheetTitle>Connection details</SheetTitle></SheetHeader><div className="mt-6 space-y-4 text-sm"><Detail label="Host" value={connectionLabel} /><Detail label={isLocal ? "Session state" : "SSH state"} value={labels[status]} />{!isLocal && <Detail label="Identity" value={root ? "Root account" : vps.username} />}{isLocal ? (<p className="text-dim"><ShieldCheck className="mr-2 inline" size={16} />Direct host session connected to the local server environment.</p>) : (<p className="text-dim"><ShieldCheck className="mr-2 inline" size={16} />Host identity is verified by the terminal service before the shell opens.</p>)}</div></SheetContent></Sheet>
  </div>;
}
function StatusDot({ status }: { status: Status }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-dim">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status === "connected"
            ? "bg-signal"
            : ["error", "expired"].includes(status)
              ? "bg-crit"
              : "bg-warn"
        }`}
        aria-hidden="true"
      />
      {labels[status]}
    </span>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-panel p-3 transition-colors duration-160 ease-out hover:bg-raised/40">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-dim">{label}</div>
      <div className="tnum mt-1 break-all font-mono text-text">{value}</div>
    </div>
  );
}
