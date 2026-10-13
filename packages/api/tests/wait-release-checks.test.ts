import { describe, expect, it, vi } from "vitest";
import {
  evaluateJobs,
  fetchAttemptJobs,
  REQUIRED_PEER_JOBS,
  waitForPeerJobs,
} from "../../../scripts/ci/wait-release-checks.mjs";

describe("CI wait-release-checks peer jobs configuration", () => {
  it("defines the exact four peer jobs and excludes own job Verify", () => {
    expect(REQUIRED_PEER_JOBS).toEqual([
      "Verify checks",
      "Verify Go checks",
      "TimescaleDB PostgreSQL migration integration",
      "Docker monitoring PostgreSQL 16",
    ]);
    expect(REQUIRED_PEER_JOBS).not.toContain("Verify");
  });
});

describe("evaluateJobs state machine and gate transitions", () => {
  const makeSuccessJobs = () =>
    REQUIRED_PEER_JOBS.map((name, idx) => ({
      id: 100 + idx,
      name,
      status: "completed",
      conclusion: "success",
    }));

  it("passes when all four required unique peer jobs completed with success", () => {
    const jobs = [
      ...makeSuccessJobs(),
      { id: 999, name: "Verify", status: "in_progress", conclusion: null },
      { id: 998, name: "changes", status: "completed", conclusion: "success" },
    ];

    const result = evaluateJobs(jobs);
    expect(result.status).toBe("success");
    expect(result.results).toHaveLength(4);
    expect(result.pendingJobs).toHaveLength(0);
    expect(result.results.every((r) => r.state === "success")).toBe(true);
  });

  it("returns pending when a required job is in_progress", () => {
    const jobs = makeSuccessJobs();
    jobs[0].status = "in_progress";
    jobs[0].conclusion = null;

    const result = evaluateJobs(jobs);
    expect(result.status).toBe("pending");
    expect(result.pendingJobs).toHaveLength(1);
    expect(result.pendingJobs[0].name).toBe("Verify checks");
    expect(result.pendingJobs[0].state).toBe("in_progress");
  });

  it("returns pending when a required job is queued", () => {
    const jobs = makeSuccessJobs();
    jobs[1].status = "queued";
    jobs[1].conclusion = null;

    const result = evaluateJobs(jobs);
    expect(result.status).toBe("pending");
    expect(result.pendingJobs).toHaveLength(1);
    expect(result.pendingJobs[0].name).toBe("Verify Go checks");
    expect(result.pendingJobs[0].state).toBe("queued");
  });

  it("returns pending with missing state when a required job is not yet in the jobs list", () => {
    const jobs = makeSuccessJobs().slice(1);

    const result = evaluateJobs(jobs);
    expect(result.status).toBe("pending");
    expect(result.pendingJobs).toHaveLength(1);
    expect(result.pendingJobs[0].name).toBe("Verify checks");
    expect(result.pendingJobs[0].state).toBe("missing");
  });

  it("fails immediately when a peer job completes with failure", () => {
    const jobs = makeSuccessJobs();
    jobs[2].status = "completed";
    jobs[2].conclusion = "failure";

    expect(() => evaluateJobs(jobs)).toThrow();
  });

  it("fails immediately when a peer job completes with cancelled", () => {
    const jobs = makeSuccessJobs();
    jobs[3].status = "completed";
    jobs[3].conclusion = "cancelled";

    expect(() => evaluateJobs(jobs)).toThrow();
  });

  it("fails immediately when a peer job completes with skipped", () => {
    const jobs = makeSuccessJobs();
    jobs[0].status = "completed";
    jobs[0].conclusion = "skipped";

    expect(() => evaluateJobs(jobs)).toThrow();
  });

  it("fails immediately when duplicate jobs exist for the same required name", () => {
    const jobs = [
      ...makeSuccessJobs(),
      {
        id: 201,
        name: "Verify checks",
        status: "completed",
        conclusion: "success",
      },
    ];

    expect(() => evaluateJobs(jobs)).toThrow();
  });
});

describe("fetchAttemptJobs pagination, authentication, and in-flight timeout", () => {
  it("authenticates and paginates through multiple pages using per_page=100", async () => {
    const requestedUrls: string[] = [];
    const requestedHeaders: Record<string, string>[] = [];

    const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      requestedUrls.push(url);
      requestedHeaders.push(init.headers as Record<string, string>);

      const parsedUrl = new URL(url);
      const page = parsedUrl.searchParams.get("page");
      const perPage = parsedUrl.searchParams.get("per_page");

      expect(perPage).toBe("100");

      if (page === "1") {
        const jobs = Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          name: `Job ${i + 1}`,
          status: "completed",
          conclusion: "success",
        }));
        return {
          ok: true,
          json: async () => ({ total_count: 105, jobs }),
        };
      }

      if (page === "2") {
        const jobs = Array.from({ length: 5 }, (_, i) => ({
          id: 101 + i,
          name: `Job ${101 + i}`,
          status: "completed",
          conclusion: "success",
        }));
        return {
          ok: true,
          json: async () => ({ total_count: 105, jobs }),
        };
      }

      return {
        ok: true,
        json: async () => ({ total_count: 105, jobs: [] }),
      };
    });

    const jobs = await fetchAttemptJobs({
      apiUrl: "https://api.github.com",
      repository: "test-owner/test-repo",
      runId: "123456",
      runAttempt: "2",
      token: "test-github-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(jobs).toHaveLength(105);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain("/repos/test-owner/test-repo/actions/runs/123456/attempts/2/jobs");
    expect(requestedUrls[0]).toContain("per_page=100&page=1");
    expect(requestedUrls[1]).toContain("per_page=100&page=2");
    expect(requestedHeaders[0].Authorization).toBe("Bearer test-github-token");
    expect(requestedHeaders[0].Accept).toBe("application/vnd.github+json");
    expect(requestedHeaders[0]["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("throws error when GitHub API returns non-2xx response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "API rate limit exceeded",
    });

    await expect(
      fetchAttemptJobs({
        apiUrl: "https://api.github.com",
        repository: "test-owner/test-repo",
        runId: "123456",
        token: "test-token",
        fetchFn: mockFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow();
  });

  it("aborts in-flight hung fetch when timeoutMs expires", async () => {
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => {
        reject(new Error(`aborted: ${init.signal?.reason}`));
      });
      return promise;
    });

    await expect(
      fetchAttemptJobs({
        apiUrl: "https://api.github.com",
        repository: "test-owner/test-repo",
        runId: "123456",
        token: "test-token",
        timeoutMs: 25,
        fetchFn: mockFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow();
  });
});

describe("waitForPeerJobs lifecycle, errors, and transition loop", () => {
  it("fails immediately on API error without swallowing or retrying", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Bad credentials",
    });

    await expect(
      waitForPeerJobs({
        apiUrl: "https://api.github.com",
        repository: "test-owner/test-repo",
        runId: "999",
        token: "bad-token",
        timeoutMs: 5000,
        fetchFn: mockFetch as unknown as typeof fetch,
        log: () => {},
      })
    ).rejects.toThrow();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts in-flight hung fetch within remaining timeoutMs", async () => {
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => {
        reject(new Error(`request hung aborted: ${init.signal?.reason}`));
      });
      return promise;
    });

    await expect(
      waitForPeerJobs({
        apiUrl: "https://api.github.com",
        repository: "test-owner/test-repo",
        runId: "999",
        token: "dummy-token",
        timeoutMs: 25,
        fetchFn: mockFetch as unknown as typeof fetch,
        log: () => {},
      })
    ).rejects.toThrow();
  });

  it("polls until pending peer jobs transition to success", async () => {
    let pollCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      pollCount += 1;
      if (pollCount === 1) {
        const jobs = REQUIRED_PEER_JOBS.map((name, idx) => ({
          id: 10 + idx,
          name,
          status: idx === 0 ? "in_progress" : "completed",
          conclusion: idx === 0 ? null : "success",
        }));
        return {
          ok: true,
          json: async () => ({ total_count: 4, jobs }),
        };
      }
      const jobs = REQUIRED_PEER_JOBS.map((name, idx) => ({
        id: 10 + idx,
        name,
        status: "completed",
        conclusion: "success",
      }));
      return {
        ok: true,
        json: async () => ({ total_count: 4, jobs }),
      };
    });

    const result = await waitForPeerJobs({
      apiUrl: "https://api.github.com",
      repository: "test-owner/test-repo",
      runId: "999",
      runAttempt: "1",
      token: "dummy-token",
      timeoutMs: 5000,
      intervalMs: 10,
      fetchFn: mockFetch as unknown as typeof fetch,
      log: () => {},
    });

    expect(result.status).toBe("success");
    expect(pollCount).toBe(2);
  });

  it("aborts immediately when a peer job fails during polling", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_count: 4,
        jobs: [
          { id: 1, name: "Verify checks", status: "completed", conclusion: "failure" },
          { id: 2, name: "Verify Go checks", status: "in_progress", conclusion: null },
          { id: 3, name: "TimescaleDB PostgreSQL migration integration", status: "queued", conclusion: null },
          { id: 4, name: "Docker monitoring PostgreSQL 16", status: "queued", conclusion: null },
        ],
      }),
    });

    await expect(
      waitForPeerJobs({
        apiUrl: "https://api.github.com",
        repository: "test-owner/test-repo",
        runId: "999",
        token: "dummy-token",
        timeoutMs: 5000,
        intervalMs: 10,
        fetchFn: mockFetch as unknown as typeof fetch,
        log: () => {},
      })
    ).rejects.toThrow();
  });

  it("fails closed on timeout if a peer job remains in_progress", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_count: 4,
        jobs: REQUIRED_PEER_JOBS.map((name, idx) => ({
          id: 10 + idx,
          name,
          status: "in_progress",
          conclusion: null,
        })),
      }),
    });

    await expect(
      waitForPeerJobs({
        apiUrl: "https://api.github.com",
        repository: "test-owner/test-repo",
        runId: "999",
        token: "dummy-token",
        timeoutMs: 25,
        intervalMs: 10,
        fetchFn: mockFetch as unknown as typeof fetch,
        log: () => {},
      })
    ).rejects.toThrow();
  });

  it("aborts when AbortSignal triggers run cancellation", async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn().mockImplementation(async () => {
      controller.abort("run cancelled by user");
      return {
        ok: true,
        json: async () => ({
          total_count: 4,
          jobs: REQUIRED_PEER_JOBS.map((name, idx) => ({
            id: 10 + idx,
            name,
            status: "in_progress",
            conclusion: null,
          })),
        }),
      };
    });

    await expect(
      waitForPeerJobs({
        apiUrl: "https://api.github.com",
        repository: "test-owner/test-repo",
        runId: "999",
        token: "dummy-token",
        timeoutMs: 5000,
        intervalMs: 10,
        signal: controller.signal,
        fetchFn: mockFetch as unknown as typeof fetch,
        log: () => {},
      })
    ).rejects.toThrow();
  });

  it("aborts immediately when own job Verify is detected as cancelled", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_count: 5,
        jobs: [
          ...REQUIRED_PEER_JOBS.map((name, idx) => ({
            id: 10 + idx,
            name,
            status: "in_progress",
            conclusion: null,
          })),
          { id: 99, name: "Verify", status: "completed", conclusion: "cancelled" },
        ],
      }),
    });

    await expect(
      waitForPeerJobs({
        apiUrl: "https://api.github.com",
        repository: "test-owner/test-repo",
        runId: "999",
        token: "dummy-token",
        timeoutMs: 5000,
        intervalMs: 10,
        fetchFn: mockFetch as unknown as typeof fetch,
        log: () => {},
      })
    ).rejects.toThrow();
  });
});
