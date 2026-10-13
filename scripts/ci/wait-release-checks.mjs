// scripts/ci/wait-release-checks.mjs
// Polls GitHub Actions run attempt jobs endpoint and waits until all four required
// peer release check jobs complete with success. Fail-closed on failure, cancellation,
// skip, duplicates, missing jobs on timeout, or run cancellation.

import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const REQUIRED_PEER_JOBS = Object.freeze([
  "Verify checks",
  "Verify Go checks",
  "TimescaleDB PostgreSQL migration integration",
  "Docker monitoring PostgreSQL 16",
]);

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_INTERVAL_MS = 2000;

export async function fetchAttemptJobs({
  apiUrl = "https://api.github.com",
  repository,
  runId,
  runAttempt = "1",
  token,
  fetchFn = globalThis.fetch,
  signal,
  timeoutMs,
}) {
  if (!token) throw new Error("fetchAttemptJobs: token is required");
  if (!repository) throw new Error("fetchAttemptJobs: repository is required");
  if (!runId) throw new Error("fetchAttemptJobs: runId is required");

  const signals = [];
  if (signal) signals.push(signal);
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  const combinedSignal =
    signals.length > 1
      ? AbortSignal.any(signals)
      : signals.length === 1
        ? signals[0]
        : undefined;

  let page = 1;
  const allJobs = [];

  while (true) {
    if (combinedSignal?.aborted) {
      throw new Error(`fetchAttemptJobs aborted: ${combinedSignal.reason || "timeout or cancelled"}`);
    }

    const endpoint = new URL(
      `${apiUrl.replace(/\/+$/, "")}/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs`
    );
    endpoint.searchParams.set("per_page", "100");
    endpoint.searchParams.set("page", String(page));

    const response = await fetchFn(endpoint.toString(), {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "vps-manager-ci-wait-release-checks",
      },
      signal: combinedSignal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `GitHub API jobs request failed (HTTP ${response.status} ${response.statusText}): ${errBody}`
      );
    }

    const payload = await response.json();
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    allJobs.push(...jobs);

    const totalCount = typeof payload?.total_count === "number" ? payload.total_count : null;
    if (jobs.length < 100 || (totalCount !== null && allJobs.length >= totalCount)) {
      break;
    }
    page += 1;
  }

  return allJobs;
}

export function evaluateJobs(jobs, requiredJobs = REQUIRED_PEER_JOBS) {
  if (!Array.isArray(jobs)) {
    throw new TypeError("jobs must be an array");
  }

  const results = [];
  const pendingJobs = [];

  for (const name of requiredJobs) {
    const matching = jobs.filter((j) => j && j.name === name);

    if (matching.length > 1) {
      throw new Error(
        `Unexpected duplicate job for required peer "${name}": found ${matching.length} instances.`
      );
    }

    if (matching.length === 0) {
      const item = { name, state: "missing", job: null };
      results.push(item);
      pendingJobs.push(item);
      continue;
    }

    const job = matching[0];
    const status = job.status;
    const conclusion = job.conclusion;

    if (status === "completed") {
      if (conclusion === "success") {
        results.push({ name, state: "success", job });
      } else {
        throw new Error(
          `Required peer job "${name}" completed with conclusion "${conclusion || "unknown"}" (expected "success").`
        );
      }
    } else {
      const state = status || "pending";
      const item = { name, state, job };
      results.push(item);
      pendingJobs.push(item);
    }
  }

  if (pendingJobs.length === 0) {
    return { status: "success", results, pendingJobs: [] };
  }

  return { status: "pending", results, pendingJobs };
}

export async function waitForPeerJobs(options = {}) {
  const {
    apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
    repository = process.env.GITHUB_REPOSITORY,
    runId = process.env.GITHUB_RUN_ID,
    runAttempt = process.env.GITHUB_RUN_ATTEMPT || "1",
    token = process.env.GITHUB_TOKEN,
    timeoutMs = Number(process.env.WAIT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    intervalMs = Number(process.env.WAIT_POLL_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
    fetchFn = globalThis.fetch,
    requiredJobs = REQUIRED_PEER_JOBS,
    signal,
    log = console.log,
  } = options;

  if (!token) {
    throw new Error("wait-release-checks: GITHUB_TOKEN environment variable is required.");
  }
  if (!repository) {
    throw new Error("wait-release-checks: GITHUB_REPOSITORY environment variable is required.");
  }
  if (!runId) {
    throw new Error("wait-release-checks: GITHUB_RUN_ID environment variable is required.");
  }

  const startTime = Date.now();
  log(`Waiting for ${requiredJobs.length} peer release checks (run attempt ${runAttempt})...`);

  let pollCount = 0;
  while (true) {
    if (signal?.aborted) {
      throw new Error(`Wait aborted: ${signal.reason || "run cancellation"}`);
    }

    pollCount += 1;
    const elapsedMs = Date.now() - startTime;
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      throw new Error(`Timed out after ${Math.round(elapsedMs / 1000)}s waiting for required peer checks.`);
    }

    const jobs = await fetchAttemptJobs({
      apiUrl,
      repository,
      runId,
      runAttempt,
      token,
      fetchFn,
      signal,
      timeoutMs: remainingMs,
    });

    const ownJob = jobs.find((j) => j && j.name === "Verify");
    if (ownJob && ownJob.conclusion === "cancelled") {
      throw new Error("Run cancellation detected: own job 'Verify' conclusion is 'cancelled'.");
    }

    const evaluation = evaluateJobs(jobs, requiredJobs);

    if (evaluation.status === "success") {
      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`All ${requiredJobs.length} peer release checks completed successfully in ${durationSec}s (${pollCount} polls).`);
      return evaluation;
    }

    const pendingSummary = evaluation.pendingJobs.map((p) => `${p.name} [${p.state}]`).join(", ");
    log(`[poll ${pollCount}] Waiting for: ${pendingSummary}`);

    const remainingAfterFetch = timeoutMs - (Date.now() - startTime);
    if (remainingAfterFetch <= 0) {
      const incompleteList = evaluation.pendingJobs.map((p) => `${p.name} (${p.state})`).join(", ");
      throw new Error(`Timed out waiting for required peer checks. Incomplete: ${incompleteList}`);
    }

    const waitDuration = Math.min(intervalMs, remainingAfterFetch);
    await sleep(waitDuration, undefined, { signal });
  }
}

const isDirectCli = Boolean(
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
);

if (isDirectCli) {
  const abortController = new AbortController();

  const handleSignal = (sig) => {
    console.error(`wait-release-checks: Received ${sig}, aborting release gate.`);
    abortController.abort(new Error(`Received ${sig}`));
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  waitForPeerJobs({ signal: abortController.signal })
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(`wait-release-checks: FAIL — ${err.message}`);
      process.exit(1);
    });
}
