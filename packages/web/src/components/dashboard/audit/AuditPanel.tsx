import { useState } from "react";
import { Activity, AlertTriangle, Copy, X } from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import { Input } from "../../ui/input";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../../ui/drawer";
import { ScrollArea } from "../../ui/scroll-area";
import { formatDate } from "../../../lib/dashboard-formatters";
import type { DashboardOverview } from "../../../lib/api";
import { EmptyState } from "../shared/EmptyState";

const selectClassName =
  "h-9 w-full rounded-none border border-line bg-ink px-3 text-[13px] text-text outline-none transition focus:border-signal focus:outline-none";

export function AuditPanel({
  events,
  compact = false,
}: {
  events: DashboardOverview["auditEvents"];
  compact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [actorFilter, setActorFilter] = useState("all");
  const [serverFilter, setServerFilter] = useState("all");
  const [quickFilter, setQuickFilter] = useState("all");
  const [selectedEvent, setSelectedEvent] = useState<
    DashboardOverview["auditEvents"][number] | null
  >(null);
  const actors = Array.from(
    new Set(events.map((event) => event.actor || "system")),
  );
  const servers = Array.from(
    new Set(
      events
        .map((event) => event.serverLabel || event.resourceId)
        .filter(Boolean) as string[],
    ),
  );
  const visibleEvents = events.filter((event) => {
    const severity =
      event.severity || (event.result === "success" ? "info" : "warning");
    const target =
      event.serverLabel ||
      event.resourceId ||
      event.resourceType ||
      "dashboard";
    const text = [
      event.actionLabel,
      event.eventCode,
      event.action,
      event.actor,
      target,
      event.result,
      event.sourceIp,
      event.requestId,
      event.reason,
      event.jobId,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesQuick =
      quickFilter === "all" ||
      (quickFilter === "critical" && severity === "critical") ||
      (quickFilter === "failures" && event.result === "failure") ||
      (quickFilter === "security" &&
        (event.action.includes("ssh") ||
          event.resourceType === "vps" ||
          event.authMethod)) ||
      (quickFilter === "terminal" && event.resourceType === "terminal");
    return (
      text.includes(query.trim().toLowerCase()) &&
      (severityFilter === "all" || severity === severityFilter) &&
      (statusFilter === "all" || event.result === statusFilter) &&
      (actorFilter === "all" || (event.actor || "system") === actorFilter) &&
      (serverFilter === "all" || target === serverFilter) &&
      matchesQuick
    );
  });
  const summary = {
    total: events.length,
    critical: events.filter((event) => event.severity === "critical").length,
    blocked: events.filter((event) => event.result === "blocked").length,
    failures: events.filter(
      (event) =>
        event.result === "failure" || event.action.includes("job.failed"),
    ).length,
    terminal: events.filter((event) => event.resourceType === "terminal")
      .length,
  };
  const displayedEvents = visibleEvents;
  if (compact) {
    return (
      <Card className="min-w-0 max-w-full overflow-hidden">
        <CardHeader className="min-w-0 border-b border-line p-4 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="truncate">Recent audit</CardTitle>
              <CardDescription>
                Latest security and operations events.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="min-w-0 overflow-hidden p-0">
          {displayedEvents.length ? (
            <div className="min-w-0">
              <div className="hidden grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto_auto] gap-3 bg-raised px-4 py-2.5 text-[11px] uppercase tracking-[0.14em] text-dim sm:grid">
                <span>Time</span>
                <span>Event</span>
                <span>Result</span>
                <span>Details</span>
              </div>
              <div className="divide-y divide-line">
                {displayedEvents.map((event) => {
                  const severity =
                    event.severity ||
                    (event.result === "success" ? "info" : "warning");
                  const isCritical = severity === "critical";
                  const detail =
                    event.reason ||
                    event.jobId ||
                    event.requestId ||
                    event.authMethod ||
                    event.client;
                  return (
                    <article
                      key={event.id}
                      className="grid min-w-0 gap-2 px-4 py-3 text-[13px] leading-6 text-dim transition-colors duration-160 ease-out hover:bg-raised/40 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto_auto] sm:items-center"
                    >
                      <span className="tnum text-dim sm:whitespace-nowrap">
                        {formatDate(event.timestamp)}
                      </span>
                      <span className="flex min-w-0 items-start gap-2 text-text">
                        <span
                          className={`mt-1 shrink-0 ${isCritical ? "text-crit" : "text-dim"}`}
                        >
                          {isCritical ? (
                            <AlertTriangle size={16} />
                          ) : (
                            <Activity size={16} />
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="block break-words font-medium">
                            {event.actionLabel || event.action}
                          </span>
                          <span className="tnum block break-all font-mono text-[11px] text-dim">
                            {event.actionLabel
                              ? event.eventCode || event.action
                              : ""}
                          </span>
                          {detail ? (
                            <span className="block break-words text-[12px] text-dim">
                              {event.reason
                                ? `Reason: ${event.reason}`
                                : String(detail)}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <Badge
                        className="w-fit uppercase"
                        variant={
                          event.result === "success"
                            ? "ready"
                            : "destructive"
                        }
                      >
                        {event.result}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 w-fit px-2 text-xs"
                        onClick={() => setSelectedEvent(event)}
                      >
                        Details
                      </Button>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="p-4">
              <EmptyState>No audit events yet.</EmptyState>
            </div>
          )}
          {selectedEvent ? (
            <AuditDetailsDrawer
              event={selectedEvent}
              onClose={() => setSelectedEvent(null)}
            />
          ) : null}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="min-w-0 max-w-full overflow-hidden">
      <CardHeader className="min-w-0 border-b border-line p-4 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="truncate">Audit</CardTitle>
            <CardDescription>
              Review security, SSH access, jobs, and terminal activity.
            </CardDescription>
          </div>
          <Badge variant={summary.critical ? "destructive" : "secondary"}>
            {summary.critical} critical
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 overflow-hidden p-0">
        <div className="border-b border-line">
            <section className="grid gap-3 border-b border-line p-4 xl:grid-cols-[minmax(0,1fr)_155px_145px_145px_165px_130px]">
              <Input
                aria-label="Search audit events"
                placeholder="Search events..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <select
                aria-label="Filter severity"
                className={selectClassName}
                value={severityFilter}
                onChange={(event) => setSeverityFilter(event.target.value)}
              >
                <option value="all">All severities</option>
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
              <select
                aria-label="Filter status"
                className={selectClassName}
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="all">All statuses</option>
                <option value="success">Success</option>
                <option value="failure">Failure</option>
                <option value="blocked">Blocked</option>
              </select>
              <select
                aria-label="Filter actor"
                className={selectClassName}
                value={actorFilter}
                onChange={(event) => setActorFilter(event.target.value)}
              >
                <option value="all">All actors</option>
                {actors.map((actor) => (
                  <option key={actor} value={actor}>
                    {actor}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter server"
                className={selectClassName}
                value={serverFilter}
                onChange={(event) => setServerFilter(event.target.value)}
              >
                <option value="all">All servers</option>
                {servers.map((server) => (
                  <option key={server} value={server}>
                    {server}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter time range"
                className={selectClassName}
                defaultValue="24h"
              >
                <option value="24h">Last 24h</option>
                <option value="7d">Last 7d</option>
              </select>
            </section>
            <section className="flex flex-wrap gap-2 p-4">
              {[
                ["all", "All events"],
                ["critical", "Critical only"],
                ["failures", "Failures"],
                ["security", "SSH/security"],
                ["terminal", "Terminal sessions"],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={quickFilter === value ? "default" : "outline"}
                  size="sm"
                  className="text-xs"
                  onClick={() => setQuickFilter(value)}
                >
                  {label}
                </Button>
              ))}
            </section>
            <section className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
              <AuditSummary label="Total events" value={summary.total} />
              <AuditSummary
                label="Critical"
                value={summary.critical}
                tone="red"
              />
              <AuditSummary
                label="Failures"
                value={summary.failures}
                tone="amber"
              />
              <AuditSummary
                label="Blocked"
                value={summary.blocked}
                tone="red"
              />
              <AuditSummary
                label="Terminal sessions"
                value={summary.terminal}
              />
            </section>
        </div>
        {displayedEvents.length ? (
          <div className="min-w-0">
            {compact ? (
              <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] gap-4 bg-raised px-4 py-2.5 text-[12px] uppercase tracking-wider text-dim md:grid">
                <span>Time / actor</span><span>Event / outcome</span><span>Action</span>
              </div>
            ) : null}
            <div className={`${compact ? "hidden" : "hidden lg:grid"} grid-cols-[1fr_1.55fr_0.8fr_1fr_0.8fr_0.8fr_1fr_0.8fr] gap-3 bg-raised px-4 py-2.5 text-[11px] uppercase tracking-[0.14em] text-dim`}>
              <span>Time</span>
              <span>Event</span>
              <span>Actor</span>
              <span>Server</span>
              <span>Severity</span>
              <span>Status</span>
              <span>Source/IP</span>
              <span>Action</span>
            </div>
            <div className="divide-y divide-line">
              {displayedEvents.map((event) => {
                const target =
                  event.serverLabel ||
                  [event.resourceType, event.resourceId]
                    .filter(Boolean)
                    .join("/") ||
                  "dashboard";
                const severity =
                  event.severity ||
                  (event.result === "success" ? "info" : "warning");
                const isCritical = severity === "critical";
                const detail =
                  event.reason ||
                  event.jobId ||
                  event.requestId ||
                  event.authMethod ||
                  event.client;
                return compact ? (
                  <article key={event.id} className="grid min-w-0 gap-3 px-4 py-3 text-[13px] leading-5 hover:bg-raised md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] md:items-start">
                    <div className="min-w-0">
                      <time dateTime={event.timestamp} className="tnum block text-dim">{formatDate(event.timestamp)}</time>
                      <span className="mt-1 block break-words text-text">{event.actor || "system"}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="break-words font-medium text-text">{event.actionLabel || event.action}</p>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        <Badge variant={severity === "critical" ? "destructive" : severity === "warning" ? "warning" : "secondary"}>{severity}</Badge>
                        <Badge variant={event.result === "success" ? "ready" : "destructive"}>{event.result}</Badge>
                      </div>
                      {event.reason ? <p className="mt-1.5 break-words text-dim">Reason: {event.reason}</p> : null}
                    </div>
                    <Button size="sm" variant="outline" className="h-8 w-fit px-2 text-xs" aria-label={`Details for ${event.actionLabel || event.action}`} onClick={() => setSelectedEvent(event)}>Details</Button>
                  </article>
                ) : (
                  <article
                    key={event.id}
                    className="grid min-w-0 gap-2 px-4 py-3 text-[13px] leading-6 text-dim transition-colors hover:bg-raised lg:grid-cols-[1fr_1.55fr_0.8fr_1fr_0.8fr_0.8fr_1fr_0.8fr] lg:items-center"
                  >
                    <span className="tnum whitespace-nowrap text-dim">
                      {formatDate(event.timestamp)}
                    </span>
                    <span className="flex min-w-0 items-start gap-2 text-text">
                      <span
                        className={`mt-1 shrink-0 ${isCritical ? "text-crit" : "text-dim"}`}
                      >
                        {isCritical ? (
                          <AlertTriangle size={16} />
                        ) : (
                          <Activity size={16} />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {event.actionLabel || event.action}
                        </span>
                        <span className="tnum block truncate font-mono text-[11px] text-dim">
                          {event.actionLabel
                            ? event.eventCode || event.action
                            : ""}
                        </span>
                        {detail ? (
                          <span className="block truncate text-[12px] text-dim">
                            {event.reason
                              ? `Reason: ${event.reason}`
                              : String(detail)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="truncate">{event.actor || "system"}</span>
                    <span className="tnum w-fit max-w-full truncate border border-line bg-raised px-2 py-1 text-[11px] text-dim">
                      {target}
                    </span>
                    <Badge
                      className="w-fit uppercase"
                      variant={
                        severity === "warning"
                          ? "warning"
                          : severity === "critical"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {severity}
                    </Badge>
                    <Badge
                      className="w-fit uppercase"
                      variant={
                        event.result === "success" ? "ready" : "destructive"
                      }
                    >
                      {event.result}
                    </Badge>
                    <span className="min-w-0">
                      <span className="tnum block truncate text-[12px] text-text">
                        {event.sourceIp || event.client || "n/a"}
                      </span>
                      {event.requestId ? (
                        <span className="tnum block truncate font-mono text-[10px] text-dim">
                          {event.requestId}
                        </span>
                      ) : null}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 w-fit px-2 text-xs"
                      onClick={() => setSelectedEvent(event)}
                    >
                      Details
                    </Button>
                  </article>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="p-4">
            <EmptyState>No audit events match these filters.</EmptyState>
          </div>
        )}
        {selectedEvent ? (
          <AuditDetailsDrawer
            event={selectedEvent}
            onClose={() => setSelectedEvent(null)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function AuditSummary({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "red" | "amber";
}) {
  const valueTone =
    tone === "red" ? "text-crit" : tone === "amber" ? "text-warn" : "text-text";
  return (
    <div className="min-w-0 border border-line bg-panel p-4">
      <p className="truncate text-[11px] uppercase tracking-[0.14em] text-dim">
        {label}
      </p>
      <strong className={`tnum mt-1.5 text-2xl font-medium ${valueTone}`}>
        {value}
      </strong>
    </div>
  );
}

function AuditDetailsDrawer({
  event,
  onClose,
}: {
  event: DashboardOverview["auditEvents"][number];
  onClose: () => void;
}) {
  const severity =
    event.severity || (event.result === "success" ? "info" : "warning");
  const target =
    event.serverLabel ||
    [event.resourceType, event.resourceId].filter(Boolean).join("/") ||
    "dashboard";
  const payload = JSON.stringify(event, null, 2);
  const copyText = (value: string) =>
    navigator.clipboard?.writeText(value).catch(() => undefined);
  return (
    <Drawer
      open
      handleOnly
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      direction="right"
    >
      <DrawerContent
        showHandle={false}
        className="inset-y-0 bottom-auto left-auto right-0 mt-0 h-full w-full max-w-2xl select-text rounded-none border-l border-line bg-panel shadow-none after:hidden"
      >
        <DrawerHeader className="border-b border-line p-5 text-left">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.14em] text-dim">
                Audit event details
              </p>
              <DrawerTitle className="mt-2 break-words text-2xl text-text">
                {event.actionLabel || event.action}
              </DrawerTitle>
              <DrawerDescription className="font-mono">
                {event.eventCode || event.action}
              </DrawerDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              aria-label="Close audit details"
              onClick={onClose}
            >
              <X size={16} />
            </Button>
          </div>
        </DrawerHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-5">
            <div className="mb-4 flex flex-wrap gap-2 bg-raised p-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => copyText(payload)}
              >
                <Copy size={14} />
                Copy payload
              </Button>
              {event.requestId ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copyText(event.requestId || "")}
                >
                  <Copy size={14} />
                  Copy request ID
                </Button>
              ) : null}
              {event.serverLabel || event.resourceId ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled
                  title="Coming soon"
                >
                  Open server
                </Button>
              ) : null}
              {event.jobId ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled
                  title="Coming soon"
                >
                  View related job
                </Button>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <AuditDetail label="Actor" value={event.actor || "system"} />
              <AuditDetail label="Server" value={target} />
              <AuditDetail label="Severity" value={severity} />
              <AuditDetail label="Status" value={event.result} />
              <AuditDetail label="Time" value={formatDate(event.timestamp)} />
              <AuditDetail
                label="Source/IP"
                value={event.sourceIp || event.client || "n/a"}
              />
              <AuditDetail
                label="Request ID"
                value={event.requestId || "n/a"}
              />
              <AuditDetail label="Related job" value={event.jobId || "n/a"} />
              <AuditDetail
                label="Auth method"
                value={event.authMethod || "n/a"}
              />
              <AuditDetail
                label="Duration"
                value={
                  event.durationMs
                    ? `${Math.round(event.durationMs / 1000)}s`
                    : "n/a"
                }
              />
            </div>
            {event.reason ? (
              <div className="mt-4 bg-raised p-4 text-[13px] text-text">
                <span className="block text-[11px] uppercase tracking-[0.14em] text-dim">
                  Reason
                </span>
                {event.reason}
              </div>
            ) : null}
            <div className="mt-4 border border-line bg-ink p-4">
              <p className="text-[11px] uppercase tracking-[0.14em] text-dim">
                Raw payload
              </p>
              <ScrollArea className="mt-3 h-96">
                <pre className="tnum whitespace-pre-wrap break-words pr-4 text-[12px] leading-5 text-text">
                  {payload}
                </pre>
              </ScrollArea>
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  );
}

function AuditDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-raised p-3">
      <p className="text-[11px] uppercase tracking-[0.14em] text-dim">
        {label}
      </p>
      <p className="tnum mt-1 break-words text-[13px] text-text">{value}</p>
    </div>
  );
}
