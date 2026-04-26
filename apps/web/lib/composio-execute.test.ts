import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter, isLikelyNoConnection } from "./composio-execute";

describe("isLikelyNoConnection", () => {
  // Status-code gating: only 4xx (and 422 specifically) qualifies as a
  // "no-connection" candidate. 5xx is always retried by the caller, and
  // 200/3xx never reach this predicate. We pin those explicitly so an
  // accidental widening (e.g., catching 500) doesn't quietly flip a
  // transient gateway failure into "user must reconnect".
  it.each([200, 201, 301, 304, 405, 500, 502, 503, 504])(
    "returns false for status %i regardless of body",
    (status) => {
      expect(isLikelyNoConnection(status, "is not active or does not exist")).toBe(false);
    },
  );

  it("returns false for 4xx with an unrelated body", () => {
    expect(isLikelyNoConnection(400, "Bad request: missing field foo")).toBe(false);
    expect(isLikelyNoConnection(404, "Tool GMAIL_FOO not found")).toBe(false);
  });

  it("matches the historical Composio hints", () => {
    // Original four hints — covered separately so a refactor that
    // accidentally drops one will fail in isolation.
    expect(isLikelyNoConnection(400, "composio_account_selection_required")).toBe(true);
    expect(isLikelyNoConnection(400, "Error: no active connection for tool")).toBe(true);
    expect(isLikelyNoConnection(400, "no connection found for slug")).toBe(true);
    expect(isLikelyNoConnection(400, '"connected_account_id is required"')).toBe(true);
  });

  // The bug that motivated this overhaul: Composio's `composio_client_error`
  // body for a revoked Gmail OAuth uses the phrase
  // `is not active or does not exist`, which the original hint list
  // didn't cover. The poll loop swallowed it silently and the inbox
  // froze for 3 days. Pin all the variants we've seen so we never
  // regress.
  it.each([
    'Connected account "ca_xxx" is not active or does not exist.',
    "Account is not active",
    "account does not exist",
    "Connection has been disabled by the workspace owner",
    "connection is disabled",
  ])("matches Composio dead-account body: %s", (body) => {
    expect(isLikelyNoConnection(400, body)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isLikelyNoConnection(400, "IS NOT ACTIVE OR DOES NOT EXIST")).toBe(true);
  });
});

describe("createConcurrencyLimiter", () => {
  it("rejects maxConcurrent <= 0", () => {
    expect(() => createConcurrencyLimiter(0)).toThrow();
    expect(() => createConcurrencyLimiter(-1)).toThrow();
  });

  it("never has more than N tasks running simultaneously", async () => {
    const limit = createConcurrencyLimiter(3);
    let active = 0;
    let peak = 0;
    const work = Array.from({ length: 20 }).map(() =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    );
    await Promise.all(work);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it("propagates resolved values", async () => {
    const limit = createConcurrencyLimiter(2);
    const result = await Promise.all([1, 2, 3].map((n) => limit(async () => n * 2)));
    expect(result).toEqual([2, 4, 6]);
  });

  it("propagates rejected promises and keeps the queue moving", async () => {
    const limit = createConcurrencyLimiter(2);
    const tasks = [
      limit(async () => "ok"),
      limit(async () => {
        throw new Error("boom");
      }),
      limit(async () => "still works"),
    ];
    const settled = await Promise.allSettled(tasks);
    expect(settled[0]).toMatchObject({ status: "fulfilled", value: "ok" });
    expect(settled[1]).toMatchObject({ status: "rejected" });
    expect(settled[2]).toMatchObject({ status: "fulfilled", value: "still works" });
  });

  it("processes tasks roughly in arrival order (FIFO)", async () => {
    const limit = createConcurrencyLimiter(1); // serialise to make order deterministic
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        limit(async () => {
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });
});
