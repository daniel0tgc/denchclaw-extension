/**
 * Behavioural contract for the per-source sync health tracking added to
 * `sync-runner.ts`. The motivating bug:
 *
 *   `tickPoller` used to swallow every Gmail/Calendar incremental
 *   failure that wasn't a `ComposioToolNoConnectionError`. A revoked
 *   OAuth produced a generic Composio 400 ("Connected account ... is
 *   not active or does not exist."), which fell into the silent catch
 *   and left the user staring at a 3-day-old inbox with no UI signal.
 *
 * This file pins down:
 *
 *   1. Successful ticks clear any prior error state and bump
 *      `lastSuccessAt` for the affected source.
 *   2. `ComposioToolNoConnectionError` flips `needsReconnect: true`
 *      and emits a "Reconnect from Integrations" progress event.
 *   3. Generic errors (HTTP 400/500/anything else) ALSO get recorded,
 *      ALSO emit a `phase: "error"` progress event, and ALSO log to
 *      `console.error` (the bug fix).
 *   4. Per-source isolation: a Gmail failure doesn't bleed into
 *      `calendar.lastError`, and vice versa.
 *   5. Streak suppression: identical consecutive failures only log the
 *      first occurrence (mirrors the gateway's sync-trigger pattern).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// All external dependencies are mocked so the test exercises only the
// orchestration logic in `tickPoller` / `recordSync*`. Real Composio
// calls, DuckDB writes, and FS IO are out of scope here.
vi.mock("./denchclaw-state", () => ({
  readConnections: vi.fn(),
  readSyncCursors: vi.fn(),
  writeSyncCursors: vi.fn(),
  readPersonalDomainsOverrides: vi.fn(() => ({ add: [], remove: [] })),
}));
vi.mock("./gmail-sync", () => ({
  runGmailBackfill: vi.fn(),
  runGmailIncremental: vi.fn(),
}));
vi.mock("./calendar-sync", () => ({
  runCalendarBackfill: vi.fn(),
  runCalendarIncremental: vi.fn(),
}));
vi.mock("./strength-score", () => ({
  recomputeAllScores: vi.fn(async () => {}),
}));
vi.mock("./workspace-schema-migrations", () => ({
  ensureLatestSchema: vi.fn(async () => {}),
}));
vi.mock("./onboarding-views", () => ({
  ensureOnboardingObjectDirs: vi.fn(),
  installDefaultViews: vi.fn(),
}));
vi.mock("./people-merge", () => ({
  mergeDuplicatePeople: vi.fn(async () => ({ rowsMerged: 0 })),
}));

const { ComposioToolNoConnectionError } = await import("./composio-execute");
const sync = await import("./sync-runner");
const denchclawState = await import("./denchclaw-state");
const gmailSync = await import("./gmail-sync");
const calendarSync = await import("./calendar-sync");

const mockedConnections = vi.mocked(denchclawState.readConnections);
const mockedCursors = vi.mocked(denchclawState.readSyncCursors);
const mockedGmailIncr = vi.mocked(gmailSync.runGmailIncremental);
const mockedCalIncr = vi.mocked(calendarSync.runCalendarIncremental);

function defaultConnections(): import("./denchclaw-state").ConnectionsFile {
  return {
    version: 1,
    gmail: {
      connectionId: "ca_gmail",
      toolkitSlug: "gmail",
      connectedAt: "2026-01-01T00:00:00.000Z",
    },
    calendar: {
      connectionId: "ca_cal",
      toolkitSlug: "google-calendar",
      connectedAt: "2026-01-01T00:00:00.000Z",
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function defaultCursors(): import("./denchclaw-state").SyncCursors {
  return {
    version: 1,
    gmail: { historyId: "1000" },
    calendar: { syncToken: "tok" },
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function gmailSummary(over: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    messagesProcessed: 0,
    peopleProcessed: 0,
    companiesProcessed: 0,
    threadsProcessed: 0,
    selfEmail: "me@example.com",
    historyId: "1001",
    pagesProcessed: 1,
    resumedFromPageToken: false,
    ...over,
  } as Awaited<ReturnType<typeof gmailSync.runGmailIncremental>>;
}

function calSummary(over: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    eventsProcessed: 0,
    peopleProcessed: 0,
    pagesProcessed: 1,
    syncToken: "tok2",
    ...over,
  } as Awaited<ReturnType<typeof calendarSync.runCalendarIncremental>>;
}

describe("sync-runner status tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sync._resetSyncRunnerForTests();
    mockedConnections.mockReturnValue(defaultConnections());
    mockedCursors.mockReturnValue(defaultCursors());
    // Silence the intentional console.error in the "first failure in a
    // streak" code path so the test runner's terminal stays readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with empty per-source status", () => {
    const s = sync.getSyncStatus();
    expect(s.gmail.lastError).toBeNull();
    expect(s.gmail.lastSuccessAt).toBeNull();
    expect(s.gmail.needsReconnect).toBe(false);
    expect(s.calendar.lastError).toBeNull();
    expect(s.calendar.consecutiveFailures).toBe(0);
  });

  it("records lastSuccessAt on a successful Gmail tick", async () => {
    mockedGmailIncr.mockResolvedValueOnce(gmailSummary({ messagesProcessed: 0 }));
    mockedCalIncr.mockResolvedValueOnce(calSummary({ eventsProcessed: 0 }));

    await sync.tickPoller();
    const s = sync.getSyncStatus();
    expect(s.gmail.lastError).toBeNull();
    expect(s.gmail.lastSuccessAt).toBeTypeOf("string");
    expect(s.calendar.lastSuccessAt).toBeTypeOf("string");
  });

  it("records a ComposioToolNoConnectionError as needsReconnect", async () => {
    mockedGmailIncr.mockRejectedValueOnce(
      new ComposioToolNoConnectionError("GMAIL_FETCH_EMAILS", "no conn", ""),
    );
    mockedCalIncr.mockResolvedValueOnce(calSummary());

    const seen: import("./sync-runner").SyncProgressEvent[] = [];
    const unsub = sync.subscribeProgress((e) => seen.push(e));
    await sync.tickPoller();
    unsub();

    const s = sync.getSyncStatus();
    expect(s.gmail.needsReconnect).toBe(true);
    expect(s.gmail.lastError).toMatch(/no conn/i);
    expect(s.gmail.consecutiveFailures).toBe(1);
    // Calendar was unaffected.
    expect(s.calendar.lastError).toBeNull();
    expect(s.calendar.lastSuccessAt).toBeTypeOf("string");

    const errorEvent = seen.find((e) => e.phase === "error" && e.source === "gmail");
    expect(errorEvent?.message).toMatch(/Reconnect from Integrations/);
  });

  it("records a generic Gmail failure (the silent-swallow bug fix)", async () => {
    // Plain Error — NOT a ComposioToolNoConnectionError. Pre-fix this
    // would have vanished into a dead try/catch with no log, no event,
    // no status update. Post-fix it must log + record + emit.
    const err = new Error('Composio HTTP 400 — "is not active or does not exist"');
    mockedGmailIncr.mockRejectedValueOnce(err);
    mockedCalIncr.mockResolvedValueOnce(calSummary());

    const consoleErrSpy = vi.spyOn(console, "error");
    const seen: import("./sync-runner").SyncProgressEvent[] = [];
    const unsub = sync.subscribeProgress((e) => seen.push(e));
    await sync.tickPoller();
    unsub();

    const s = sync.getSyncStatus();
    expect(s.gmail.lastError).toBe(err.message);
    expect(s.gmail.needsReconnect).toBe(false);
    expect(s.gmail.lastSuccessAt).toBeNull(); // never had one
    // First failure in a streak → console.error fires.
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[sync-runner] gmail sync failed:"),
    );
    // SSE listener saw a structured error event with source: "gmail".
    const errorEvent = seen.find((e) => e.phase === "error" && e.source === "gmail");
    expect(errorEvent?.message).toContain("Gmail sync failed");
    expect(errorEvent?.error).toBe(err.message);
  });

  it("clears prior error state on the next successful tick", async () => {
    mockedGmailIncr.mockRejectedValueOnce(new Error("transient 502"));
    mockedCalIncr.mockResolvedValueOnce(calSummary());
    await sync.tickPoller();
    expect(sync.getSyncStatus().gmail.lastError).toMatch(/502/);

    mockedGmailIncr.mockResolvedValueOnce(gmailSummary());
    mockedCalIncr.mockResolvedValueOnce(calSummary());
    await sync.tickPoller();

    const s = sync.getSyncStatus();
    expect(s.gmail.lastError).toBeNull();
    expect(s.gmail.consecutiveFailures).toBe(0);
    expect(s.gmail.lastSuccessAt).toBeTypeOf("string");
  });

  it("counts consecutive identical failures into the streak counter", async () => {
    const sameErr = new Error("Composio HTTP 502 — bad gateway");
    mockedGmailIncr.mockRejectedValue(sameErr);
    mockedCalIncr.mockResolvedValue(calSummary());

    const consoleErrSpy = vi.spyOn(console, "error");

    await sync.tickPoller();
    await sync.tickPoller();
    await sync.tickPoller();

    const s = sync.getSyncStatus();
    expect(s.gmail.consecutiveFailures).toBe(3);
    // Only the first identical failure logs (mirrors sync-trigger).
    expect(consoleErrSpy).toHaveBeenCalledTimes(1);
  });

  it("resets the streak counter when the failure mode changes", async () => {
    mockedGmailIncr.mockRejectedValueOnce(new Error("HTTP 502 — bad gateway"));
    mockedCalIncr.mockResolvedValueOnce(calSummary());
    await sync.tickPoller();

    mockedGmailIncr.mockRejectedValueOnce(new Error("HTTP 500 — different mode"));
    mockedCalIncr.mockResolvedValueOnce(calSummary());
    await sync.tickPoller();

    expect(sync.getSyncStatus().gmail.consecutiveFailures).toBe(1);
  });

  it("isolates Gmail and Calendar failures from each other", async () => {
    mockedGmailIncr.mockRejectedValueOnce(new Error("gmail boom"));
    mockedCalIncr.mockRejectedValueOnce(new Error("calendar boom"));
    await sync.tickPoller();

    const s = sync.getSyncStatus();
    expect(s.gmail.lastError).toBe("gmail boom");
    expect(s.calendar.lastError).toBe("calendar boom");
    // Each gets its own first-failure log line.
    // (Asserted indirectly via streak counters being 1 for both.)
    expect(s.gmail.consecutiveFailures).toBe(1);
    expect(s.calendar.consecutiveFailures).toBe(1);
  });

  it("does not run Gmail incremental when no historyId is in the cursor", async () => {
    // Backfill hasn't completed yet → no historyId → tick is a no-op for Gmail.
    mockedCursors.mockReturnValue({
      version: 1,
      gmail: {},
      calendar: { syncToken: "tok" },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockedCalIncr.mockResolvedValueOnce(calSummary());
    await sync.tickPoller();
    expect(mockedGmailIncr).not.toHaveBeenCalled();
    // Status stays empty for Gmail, success for Calendar.
    expect(sync.getSyncStatus().gmail.lastError).toBeNull();
    expect(sync.getSyncStatus().gmail.lastSuccessAt).toBeNull();
    expect(sync.getSyncStatus().calendar.lastSuccessAt).toBeTypeOf("string");
  });
});
