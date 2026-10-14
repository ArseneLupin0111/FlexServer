import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { chipVariant, formatDate, freshnessLabel } from "../../../lib/dashboard-formatters";
import type { DashboardOverview } from "../../../lib/api";
import { EmptyState } from "../shared/EmptyState";
import { SummaryPill } from "../shared/SummaryPill";

const selectClassName =
  "h-9 w-full rounded-none border border-line bg-ink px-3 text-[13px] text-text outline-none transition focus:border-signal focus:outline-none";

export function JobsPanel({
  jobs,
  compact = false,
}: {
  jobs: DashboardOverview["jobs"];
  compact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get("status");
  const [statusFilter, setStatusFilter] = useState(
    initialStatus &&
      ["all", "queued", "running", "succeeded", "failed", "cancelled"].includes(
        initialStatus,
      )
      ? initialStatus
      : "all",
  );
  const [typeFilter, setTypeFilter] = useState("all");
  const [viewMode, setViewMode] = useState<"compact" | "detailed">("compact");
  const running = jobs.filter((job) => job.status === "running").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  const queued = jobs.filter((job) => job.status === "queued").length;
  const workers = new Set(jobs.map((job) => job.workerId).filter(Boolean)).size;
  const completed = jobs.filter(
    (job) => job.status === "succeeded" || job.status === "failed",
  ).length;
  const succeeded = jobs.filter((job) => job.status === "succeeded").length;
  const successRate = completed ? Math.round((succeeded / completed) * 100) : 0;
  const jobTypes = Array.from(new Set(jobs.map((job) => job.type))).sort();
  const visibleJobs = jobs.filter((job) => {
    const haystack = [
      job.type,
      job.id,
      job.vpsId,
      job.workerId,
      job.status,
      job.errorMessage,
      job.outputPreview,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (
      haystack.includes(query.trim().toLowerCase()) &&
      (statusFilter === "all" || job.status === statusFilter) &&
      (typeFilter === "all" || job.type === typeFilter)
    );
  });

  if (compact) {
    return (
      <Card className="min-w-0 max-w-full overflow-hidden">
        <CardHeader className="min-w-0 border-b border-line p-4 pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="truncate">Recent jobs</CardTitle>
            <Badge
              variant={running ? (failed ? "destructive" : "pending") : "secondary"}
            >
              {failed ? `${failed} failed · ` : ""}{running} running
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="min-w-0 overflow-hidden p-0">
          {jobs.length ? (
            <div className="divide-y divide-line">
              {jobs
                .slice(0, 5)
                .map((job) => <CompactJobRow key={job.id} job={job} />)}
            </div>
          ) : (
            <div className="p-4">
              <EmptyState>No jobs yet.</EmptyState>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="min-w-0 max-w-full overflow-hidden">
      <CardHeader className="min-w-0 border-b border-line p-4 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">Jobs</CardTitle>
            <CardDescription>
              Background work across provisioning, metrics, and key checks.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div
              role="group"
              aria-label="Job view style"
              className="flex items-center gap-1 border border-line p-1"
            >
              <Button
                type="button"
                variant={viewMode === "compact" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setViewMode("compact")}
              >
                Compact view
              </Button>
              <Button
                type="button"
                variant={viewMode === "detailed" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setViewMode("detailed")}
              >
                Detailed view
              </Button>
            </div>
            <Button type="button" variant="outline" size="sm" className="ml-1">
              Logs
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 overflow-hidden p-0">
        <section
          className="grid gap-3 border-b border-line p-4 md:grid-cols-[minmax(0,1fr)_170px_190px]"
          aria-label="Jobs filters"
        >
          <Input
            aria-label="Search jobs"
            placeholder="Search jobs..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            aria-label="Filter job status"
            className={selectClassName}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
          </select>
          <select
            aria-label="Filter job type"
            className={selectClassName}
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            <option value="all">All types</option>
            {jobTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </section>
        {visibleJobs.length ? (
          <div className="divide-y divide-line">
            {visibleJobs.map((job) =>
              viewMode === "compact" ? (
                <JobCompactListRow key={job.id} job={job} />
              ) : (
                <JobCard key={job.id} job={job} />
              ),
            )}
          </div>
        ) : (
          <div className="p-4">
            <EmptyState>No jobs match these filters.</EmptyState>
          </div>
        )}
        <section
          className="grid grid-cols-1 gap-3 border-t border-line p-4 sm:grid-cols-2 xl:grid-cols-5"
          aria-label="Jobs summary"
        >
          <SummaryPill label="Workers" value={`${workers || 0}`} />
          <SummaryPill label="Running" value={`${running}`} />
          <SummaryPill label="Queued" value={`${queued}`} />
          <SummaryPill
            label="Failed"
            value={`${failed}`}
            tone={failed ? "red" : "default"}
          />
          <SummaryPill
            label="Success rate"
            value={completed ? `${successRate}%` : "n/a"}
          />
        </section>
      </CardContent>
    </Card>
  );
}

function CompactJobRow({ job }: { job: DashboardOverview["jobs"][number] }) {
  const progress = Math.min(100, Math.max(0, job.progress));
  const isRunning = job.status === "running";
  const meta = [job.workerId, job.status === "failed" ? `Failed at ${progress}%` : isRunning ? `${progress}% progress` : job.status === "queued" ? "Waiting for a worker" : job.status === "cancelled" ? `Cancelled at ${progress}%` : "Completed"].filter(Boolean).join(" · ");
  return (
    <article className="grid min-w-0 gap-2 px-4 py-3 transition-colors duration-160 ease-out hover:bg-raised/40">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <strong
            className="block truncate text-[15px] font-medium leading-6 text-text"
            title={job.type}
          >
            {job.type}
          </strong>
          <p
            className="mt-1 whitespace-normal break-words text-[13px] leading-6 text-dim"
            title={meta}
          >
            {meta}
          </p>
        </div>
        <Badge className="shrink-0 uppercase" variant={chipVariant(job.status)}>
          {job.status}
        </Badge>
      </div>
      {job.status === "failed" ? <p className="break-words text-[13px] text-text">{job.errorMessage || "Failure reason not reported."}</p> : null}
      {job.finishedAt ? <time dateTime={job.finishedAt} className="text-[12px] text-dim">Finished {formatDate(job.finishedAt)}</time> : null}
      {!job.finishedAt && job.startedAt ? <time dateTime={job.startedAt} className="text-[12px] text-dim">Started {formatDate(job.startedAt)}</time> : null}
      {job.errorLogUrl ? <a href={job.errorLogUrl} target="_blank" rel="noopener noreferrer" className="w-fit text-[12px] text-text underline underline-offset-4">View log</a> : null}
      {isRunning ? (
      <div
        className="h-1 overflow-hidden bg-line"
        role="progressbar"
        aria-label={`${job.type} progress`}
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full bg-signal"
          style={{ width: `${progress}%` }}
        />
      </div>
      ) : null}
      <Link to={`/vps/${encodeURIComponent(job.vpsId)}/jobs`} className="w-fit text-[12px] text-signal underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-signal">View details</Link>
    </article>
  );
}

function JobCompactListRow({
  job,
}: {
  job: DashboardOverview["jobs"][number];
}) {
  const progress = Math.min(100, Math.max(0, job.progress));
  const isFailed = job.status === "failed";
  const isRunning = job.status === "running";
  const isQueued = job.status === "queued";
  const durationText =
    job.durationMs != null
      ? `${(job.durationMs / 1000).toFixed(0)}s`
      : null;
  const meta = [
    job.vpsId,
    job.workerId,
    durationText,
    `${job.retryCount ?? 0} retries`,
    job.startedAt ? `started ${freshnessLabel(job.startedAt)}` : null,
    job.finishedAt ? `finished ${formatDate(job.finishedAt)}` : null,
    isFailed ? `Failed at ${progress}%` : job.status === "cancelled" ? `Cancelled at ${progress}%` : null,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
  return (
    <article className="grid min-w-0 gap-2 px-4 py-3 transition-colors duration-160 ease-out hover:bg-raised/40 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <strong
            className="truncate text-[14px] font-medium text-text"
            title={job.type}
          >
            {job.type}
          </strong>
          <JobStatusBadge status={job.status} />
          <span className="tnum truncate font-mono text-[11px] text-dim">
            {job.id}
          </span>
        </div>
        <p className="mt-1 truncate text-[12px] text-dim" title={meta}>
          {meta}
        </p>
        {isQueued ? (
          <p className="mt-1 text-[12px] text-dim">
            Queued / {job.outputPreview || "Waiting for an available worker."}
          </p>
        ) : null}
        {isFailed ? (
          <p className="mt-1 break-words text-[13px] text-text">
            {job.errorMessage || "Failure reason not reported."}
          </p>
        ) : null}
        {isRunning ? (
          <div
            className="mt-2 h-1 overflow-hidden bg-line"
            role="progressbar"
            aria-label={`${job.type} progress`}
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full ${isFailed ? "bg-crit" : "bg-signal"}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        {isRunning ? (
          <span className="tnum min-w-12 text-right text-[12px] text-dim">
            {progress}%
          </span>
        ) : null}
        {job.errorLogUrl ? (
          <Button
            type="button"
            asChild
            variant={
              isFailed ? "destructive" : isRunning ? "secondary" : "outline"
            }
            size="sm"
          >
            <a href={job.errorLogUrl} target="_blank" rel="noopener noreferrer">
              View log
            </a>
          </Button>
        ) : null}
        {isRunning ? (
          <Button type="button" variant="outline" size="sm" disabled>
            Cancel
          </Button>
        ) : null}
        {isFailed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-crit hover:border-crit hover:bg-crit/10"
            disabled
          >
            Retry
          </Button>
        ) : null}
        <JobOverflow job={job} />
      </div>
    </article>
  );
}

function JobCard({ job }: { job: DashboardOverview["jobs"][number] }) {
  const progress = Math.min(100, Math.max(0, job.progress));
  const durationText =
    job.durationMs != null
      ? `${(job.durationMs / 1000).toFixed(0)}s`
      : null;
  const retryText = `${job.retryCount ?? 0} retries`;
  const timeBits = [
    job.startedAt ? `Started ${freshnessLabel(job.startedAt)}` : null,
    job.finishedAt ? `Finished ${formatDate(job.finishedAt)}` : null,
  ].filter(Boolean);
  const isFailed = job.status === "failed";
  const isRunning = job.status === "running";
  const isQueued = job.status === "queued";
  const inlineMeta = [
    job.vpsId,
    job.workerId,
    durationText,
    retryText,
    ...timeBits,
  ].filter(Boolean).join(" \u00b7 ");
  return (
    <article className="grid min-w-0 gap-3 px-4 py-4 transition-colors duration-160 ease-out hover:bg-raised/40">
      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <strong
              className="truncate text-[16px] font-medium leading-6 text-text"
              title={job.type}
            >
              {job.type}
            </strong>
            <JobStatusBadge status={job.status} />
          </div>
          <p className="tnum mt-1 break-all font-mono text-[11px] text-dim">
            {job.id}
          </p>
          <p className="mt-2 text-[13px] leading-5 text-dim">{inlineMeta}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          {job.errorLogUrl ? (
            <Button
              type="button"
              asChild
              variant={
                isFailed ? "destructive" : isRunning ? "secondary" : "outline"
              }
              size="sm"
            >
              <a
                href={job.errorLogUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View log
              </a>
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled>
              View log
            </Button>
          )}
          {isRunning ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled
              title="Cancel is not wired to an API yet"
            >
              Cancel
            </Button>
          ) : null}
          {isFailed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-crit hover:border-crit hover:bg-crit/10"
              disabled
              title="Retry is not wired to an API yet"
            >
              Retry
            </Button>
          ) : null}
          <JobOverflow job={job} />
        </div>
      </div>
      {isQueued ? (
        <p className="border border-line bg-ink px-3 py-2 text-[13px] leading-5 text-dim">
          Queued / {job.outputPreview || "Waiting for an available worker."}
        </p>
      ) : !isRunning ? (
        <p className="tnum text-[13px] text-dim">{isFailed ? `Failed at ${progress}%` : job.status === "cancelled" ? `Cancelled at ${progress}%` : "Completed"}</p>
      ) : (
        <div>
          <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.14em] text-dim">
            <span>Progress</span>
            <span className="tnum">{progress}%</span>
          </div>
          <div
            className="mt-2 h-1 overflow-hidden bg-line"
            role="progressbar"
            aria-label={`${job.type} progress`}
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full ${isFailed ? "bg-crit" : "bg-signal"}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
      {isFailed || job.errorMessage ? (
        <p className="border border-line bg-ink px-3 py-2 text-[13px] leading-5 text-text">
          {job.errorMessage || "Failure reason not reported."}
        </p>
      ) : job.outputPreview && !isQueued ? (
        <p className="border border-line bg-ink px-3 py-2 text-[13px] leading-5 text-dim">
          {job.outputPreview}
        </p>
      ) : null}
    </article>
  );
}

function JobStatusBadge({
  status,
}: {
  status: DashboardOverview["jobs"][number]["status"];
}) {
  if (status === "running")
    return (
      <span className="inline-flex items-center border border-info/40 bg-info/10 px-2 py-1 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.06em] text-info">
        Running
      </span>
    );
  return (
    <Badge className="uppercase" variant={chipVariant(status)}>
      {status}
    </Badge>
  );
}

function JobOverflow({ job }: { job: DashboardOverview["jobs"][number] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2"
          aria-label={`More actions for ${job.id}`}
        >
          <MoreHorizontal size={15} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem disabled className="opacity-45">
          Restart worker
        </DropdownMenuItem>
        <DropdownMenuItem disabled className="opacity-45">
          Open server
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => navigator.clipboard?.writeText(job.id)}
        >
          Copy job id
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
