import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter } from "./composio-execute";

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
