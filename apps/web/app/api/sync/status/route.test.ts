/**
 * Contract for `/api/sync/status`. The endpoint fans together two
 * independent signals — in-memory `getSyncStatus()` from `sync-runner`
 * and on-disk `lastPolledAt` from `denchclaw-state` — into a single
 * payload the workspace banner component polls every 60s.
 *
 * Cases pinned here:
 *
 *   1. Happy path: returns both sources with `stale: false` when the
 *      most recent success was within the staleness window.
 *   2. `stale: true` when no successful tick (in-memory or on-disk)
 *      has happened in > 30min — that's the "gateway daemon crashed"
 *      signal the banner uses to nag the operator to run
 *      `denchclaw start`.
 *   3. The on-disk `lastPolledAt` is honoured even when the in-memory
 *      `lastSuccessAt` is null (= post-restart, before the first new
 *      tick). Without this, every Next.js HMR would falsely show a
 *      stale banner for the first 30 minutes.
 *   4. `Cache-Control: no-store` is set so the banner reflects truth
 *      the moment a tick succeeds/fails.
 *   5. `serverNow` is a valid ISO timestamp so the client can use it
 *      as the "now" reference instead of a skewed local clock.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/sync-runner", () => ({
  getSyncStatus: vi.fn(),
}));
vi.mock("@/lib/denchclaw-state", () => ({
  readSyncCursors: vi.fn(),
}));

const { GET } = await import("./route");
const { getSyncStatus } = await import("@/lib/sync-runner");
const { readSyncCursors } = await import("@/lib/denchclaw-state");

const mockedStatus = vi.mocked(getSyncStatus);
const mockedCursors = vi.mocked(readSyncCursors);

function emptyStatus() {
  return {
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    needsReconnect: false,
  };
}

describe("/api/sync/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns gmail/calendar/serverNow with no-store caching", async () => {
    mockedStatus.mockReturnValue({
      gmail: { ...emptyStatus(), lastSuccessAt: new Date().toISOString() },
      calendar: { ...emptyStatus(), lastSuccessAt: new Date().toISOString() },
    });
    mockedCursors.mockReturnValue({
      version: 1,
      updatedAt: new Date().toISOString(),
    });

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.gmail).toBeDefined();
    expect(body.calendar).toBeDefined();
    expect(typeof body.serverNow).toBe("string");
    // serverNow must round-trip through Date.parse without NaN —
    // critical because the client uses it as the staleness anchor.
    expect(Number.isFinite(Date.parse(body.serverNow))).toBe(true);
    expect(body.gmail.stale).toBe(false);
    expect(body.calendar.stale).toBe(false);
  });

  it("marks a source as stale when the most recent tick is > 30min old", async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    mockedStatus.mockReturnValue({
      gmail: { ...emptyStatus(), lastSuccessAt: longAgo },
      calendar: { ...emptyStatus() },
    });
    mockedCursors.mockReturnValue({
      version: 1,
      gmail: { lastPolledAt: longAgo },
      calendar: { lastPolledAt: longAgo },
      updatedAt: new Date().toISOString(),
    });

    const res = await GET();
    const body = await res.json();
    expect(body.gmail.stale).toBe(true);
    expect(body.calendar.stale).toBe(true);
  });

  it("uses on-disk lastPolledAt when in-memory lastSuccessAt is null (post-restart)", async () => {
    // Simulates a fresh Next.js process: in-memory state is empty, but
    // the on-disk cursor reflects a recent successful poll done by an
    // earlier process. Without honouring the cursor, the banner would
    // false-positive "stale" for 30 minutes after every dev HMR.
    const recent = new Date(Date.now() - 60_000).toISOString(); // 1min ago
    mockedStatus.mockReturnValue({
      gmail: emptyStatus(),
      calendar: emptyStatus(),
    });
    mockedCursors.mockReturnValue({
      version: 1,
      gmail: { lastPolledAt: recent },
      calendar: { lastPolledAt: recent },
      updatedAt: recent,
    });

    const res = await GET();
    const body = await res.json();
    expect(body.gmail.stale).toBe(false);
    expect(body.calendar.stale).toBe(false);
    // The on-disk timestamp surfaces in the response so the client
    // doesn't have to round-trip back to the cursor file.
    expect(body.gmail.lastPolledAt).toBe(recent);
    expect(body.calendar.lastPolledAt).toBe(recent);
  });

  it("never reports stale when there has never been any successful tick", async () => {
    // First-run / pre-backfill state: no in-memory success, no cursor.
    // We deliberately don't show "stale" here because the user simply
    // hasn't connected anything yet — banner stays quiet until a
    // genuine error or a long-stale tick.
    mockedStatus.mockReturnValue({
      gmail: emptyStatus(),
      calendar: emptyStatus(),
    });
    mockedCursors.mockReturnValue({
      version: 1,
      updatedAt: new Date().toISOString(),
    });

    const res = await GET();
    const body = await res.json();
    expect(body.gmail.stale).toBe(false);
    expect(body.calendar.stale).toBe(false);
  });

  it("propagates lastError + needsReconnect through to the response", async () => {
    mockedStatus.mockReturnValue({
      gmail: {
        ...emptyStatus(),
        lastError: "Connected account ca_xxx is not active or does not exist.",
        lastErrorAt: new Date().toISOString(),
        consecutiveFailures: 4,
        needsReconnect: true,
      },
      calendar: emptyStatus(),
    });
    mockedCursors.mockReturnValue({ version: 1, updatedAt: new Date().toISOString() });

    const res = await GET();
    const body = await res.json();
    expect(body.gmail.lastError).toMatch(/not active or does not exist/);
    expect(body.gmail.needsReconnect).toBe(true);
    expect(body.gmail.consecutiveFailures).toBe(4);
  });
});
