/**
 * Contract for the `/api/sync/refresh` endpoint shared by the agent
 * tools (`denchclaw_refresh_sync`, `denchclaw_resync_full`) and the
 * `SyncHealthBanner`'s "Refresh now" button.
 *
 * Cases pinned here:
 *
 *   1. Loopback host check rejects external traffic with 403, same way
 *      `poll-tick` does.
 *   2. Default mode is "incremental" → calls `tickPoller`, never
 *      `startBackfill` — important so a "Refresh now" button click
 *      doesn't accidentally re-import the user's whole mailbox.
 *   3. `mode: "backfill"` → calls `startBackfill`. Already-running
 *      surfaces as a 200 with `alreadyRunning: true` (intent satisfied
 *      either way), missing Gmail connection surfaces as 409.
 *   4. Incremental tick during an in-progress backfill is skipped, not
 *      run twice — same semantics as `poll-tick`.
 *   5. Missing/empty body defaults to incremental (no Content-Length
 *      shenanigans), invalid JSON returns 400, invalid mode returns 400.
 *   6. `tickPoller` throws → 500 with the error message surfaced.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sync-runner", () => ({
  tickPoller: vi.fn(async () => {}),
  startBackfill: vi.fn(),
  isBackfillRunning: vi.fn(() => false),
  getLastProgressEvent: vi.fn(() => null),
}));

const { POST } = await import("./route");
const {
  tickPoller,
  startBackfill,
  isBackfillRunning,
  getLastProgressEvent,
} = await import("@/lib/sync-runner");

const mockedTick = vi.mocked(tickPoller);
const mockedStartBackfill = vi.mocked(startBackfill);
const mockedBackfillRunning = vi.mocked(isBackfillRunning);
const mockedLastEvent = vi.mocked(getLastProgressEvent);

function makeRequest(opts: {
  body?: unknown;
  /** Pass `null` to omit the body entirely (matches `fetch(url, { method: "POST" })`). */
  omitBody?: boolean;
  host?: string | null;
  forwardedHost?: string | null;
  /** Override the JSON body with raw text (for the malformed-JSON test). */
  rawBody?: string;
}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.host !== null) {
    headers.set("host", opts.host ?? "127.0.0.1:3100");
  }
  if (opts.forwardedHost) {
    headers.set("x-forwarded-host", opts.forwardedHost);
  }
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  } else if (!opts.omitBody) {
    body = JSON.stringify(opts.body ?? {});
  }
  return new Request("http://127.0.0.1:3100/api/sync/refresh", {
    method: "POST",
    headers,
    body,
  });
}

describe("/api/sync/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedBackfillRunning.mockReturnValue(false);
    mockedLastEvent.mockReturnValue(null);
    mockedStartBackfill.mockReturnValue({ started: true, alreadyRunning: false });
  });

  it("rejects non-loopback hosts with 403 (no work attempted)", async () => {
    const res = await POST(makeRequest({ host: "evil.example.com" }));
    expect(res.status).toBe(403);
    expect(mockedTick).not.toHaveBeenCalled();
    expect(mockedStartBackfill).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1:3100", "localhost:3100", "[::1]:3100"])(
    "accepts loopback host %s",
    async (host) => {
      const res = await POST(makeRequest({ host }));
      expect(res.status).toBe(200);
    },
  );

  it("rejects spoofed x-forwarded-host even when host is loopback", async () => {
    const res = await POST(
      makeRequest({ host: "127.0.0.1:3100", forwardedHost: "evil.example.com" }),
    );
    expect(res.status).toBe(403);
  });

  it("defaults to incremental mode when body is omitted", async () => {
    // Critical: `fetch(url, { method: "POST" })` from the UI button
    // sends no body. The route must treat that as incremental, not
    // accidentally fall through to backfill.
    const res = await POST(makeRequest({ omitBody: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("incremental");
    expect(mockedTick).toHaveBeenCalledTimes(1);
    expect(mockedStartBackfill).not.toHaveBeenCalled();
  });

  it("defaults to incremental mode when body is empty object", async () => {
    const res = await POST(makeRequest({ body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("incremental");
    expect(mockedTick).toHaveBeenCalledTimes(1);
  });

  it("explicit mode: incremental calls tickPoller", async () => {
    mockedLastEvent.mockReturnValue({
      phase: "polling",
      message: "Synced 2 new emails.",
      messagesProcessed: 2,
      peopleProcessed: 0,
      companiesProcessed: 0,
      threadsProcessed: 0,
      eventsProcessed: 0,
    });
    const res = await POST(makeRequest({ body: { mode: "incremental" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("incremental");
    expect(body.lastEvent?.message).toBe("Synced 2 new emails.");
    expect(typeof body.ranAt).toBe("string");
    expect(mockedTick).toHaveBeenCalledTimes(1);
    expect(mockedStartBackfill).not.toHaveBeenCalled();
  });

  it("explicit mode: backfill calls startBackfill", async () => {
    const res = await POST(makeRequest({ body: { mode: "backfill" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("backfill");
    expect(body.started).toBe(true);
    expect(mockedStartBackfill).toHaveBeenCalledTimes(1);
    expect(mockedTick).not.toHaveBeenCalled();
  });

  it("backfill mode: already-running surfaces as 200 with alreadyRunning flag", async () => {
    mockedBackfillRunning.mockReturnValue(true);
    const res = await POST(makeRequest({ body: { mode: "backfill" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyRunning).toBe(true);
    // Critically, we don't call startBackfill again — that would no-op,
    // but the explicit short-circuit makes the contract obvious.
    expect(mockedStartBackfill).not.toHaveBeenCalled();
  });

  it("backfill mode: refusal (no Gmail connection) surfaces as 409", async () => {
    mockedStartBackfill.mockReturnValue({
      started: false,
      alreadyRunning: false,
      reason: "No Gmail connection. Connect Gmail before starting the sync.",
    });
    const res = await POST(makeRequest({ body: { mode: "backfill" } }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/No Gmail connection/);
  });

  it("incremental mode: skipped when a backfill is in flight", async () => {
    // Same contract as poll-tick — the backfill will catch up the
    // incremental window so an additional tick would be wasted work.
    mockedBackfillRunning.mockReturnValue(true);
    const res = await POST(makeRequest({ body: { mode: "incremental" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe("backfill-in-progress");
    expect(mockedTick).not.toHaveBeenCalled();
  });

  it("incremental mode: surfaces tickPoller errors as 500", async () => {
    mockedTick.mockRejectedValueOnce(new Error("DuckDB locked"));
    const res = await POST(makeRequest({ body: { mode: "incremental" } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/DuckDB locked/);
  });

  it("malformed JSON body returns 400", async () => {
    const res = await POST(
      new Request("http://127.0.0.1:3100/api/sync/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1:3100" },
        body: "{not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid JSON/);
  });

  it("invalid mode value returns 400", async () => {
    const res = await POST(makeRequest({ body: { mode: "nuke" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid mode/);
    expect(mockedTick).not.toHaveBeenCalled();
    expect(mockedStartBackfill).not.toHaveBeenCalled();
  });
});
