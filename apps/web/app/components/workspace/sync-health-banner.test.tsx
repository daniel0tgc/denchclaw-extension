// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SyncHealthBanner } from "./sync-health-banner";

/**
 * UI contract for the workspace sync-health banner.
 *
 * The banner is the user-visible counterpart of the silent-swallow bug
 * fix. Its job is narrowly scoped:
 *
 *   - When `/api/sync/status` reports an active error → render a
 *     red-bordered sticky card per source.
 *   - When the same status reports needsReconnect → show a Reconnect CTA.
 *   - When the user dismisses → hide for that exact failure mode but
 *     reappear if the failure mode changes (different errorKey).
 *   - When status flips back to clean → banner disappears with no extra
 *     interaction needed.
 *
 * What we deliberately don't test here: the visual styling (fonts,
 * border colours) and the 60s default polling cadence. The cadence is
 * pinned via the `pollIntervalMs` prop override.
 */

type StatusBody = {
  gmail: SourcePayload;
  calendar: SourcePayload;
  serverNow: string;
};

type SourcePayload = {
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  lastPolledAt: string | null;
  consecutiveFailures: number;
  needsReconnect: boolean;
  stale: boolean;
};

function emptySource(): SourcePayload {
  return {
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: new Date().toISOString(),
    lastPolledAt: new Date().toISOString(),
    consecutiveFailures: 0,
    needsReconnect: false,
    stale: false,
  };
}

function jsonResponse(body: StatusBody): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockStatusSequence(...bodies: StatusBody[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => jsonResponse(bodies[0] ?? cleanBody()));
  let i = 0;
  fn.mockImplementation(async () => {
    const body = bodies[Math.min(i, bodies.length - 1)] ?? cleanBody();
    i += 1;
    return jsonResponse(body);
  });
  return fn;
}

function cleanBody(): StatusBody {
  return {
    gmail: emptySource(),
    calendar: emptySource(),
    serverNow: new Date().toISOString(),
  };
}

function gmailReconnectBody(): StatusBody {
  return {
    gmail: {
      ...emptySource(),
      lastError: "Connected account ca_xxx is not active or does not exist.",
      lastErrorAt: new Date().toISOString(),
      lastSuccessAt: null,
      consecutiveFailures: 3,
      needsReconnect: true,
    },
    calendar: emptySource(),
    serverNow: new Date().toISOString(),
  };
}

function gmailGenericErrorBody(message: string): StatusBody {
  return {
    gmail: {
      ...emptySource(),
      lastError: message,
      lastErrorAt: new Date().toISOString(),
      lastSuccessAt: null,
      consecutiveFailures: 1,
      needsReconnect: false,
    },
    calendar: emptySource(),
    serverNow: new Date().toISOString(),
  };
}

describe("SyncHealthBanner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing while the first poll is in flight", () => {
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>(() => {
          /* never resolves */
        }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;
    const { container } = render(<SyncHealthBanner pollIntervalMs={1000} />);
    // No banner content yet — the initial poll is pending.
    expect(container.querySelector('[data-testid^="sync-health-banner-"]')).toBeNull();
  });

  it("renders nothing when both sources report success", async () => {
    global.fetch = mockStatusSequence(cleanBody()) as unknown as typeof fetch;
    render(<SyncHealthBanner pollIntervalMs={1000} />);
    // Wait one tick for the initial poll to resolve.
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("sync-health-banner-gmail")).toBeNull();
    expect(screen.queryByTestId("sync-health-banner-calendar")).toBeNull();
  });

  it("renders a Gmail Reconnect banner when needsReconnect is true", async () => {
    global.fetch = mockStatusSequence(gmailReconnectBody()) as unknown as typeof fetch;
    render(<SyncHealthBanner pollIntervalMs={1000} />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument();
    });
    expect(screen.getByText(/Gmail sync paused/i)).toBeInTheDocument();
    expect(screen.getByText(/Reconnect from the Integrations panel/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reconnect$/ })).toBeInTheDocument();
    // Calendar is still healthy → no calendar banner.
    expect(screen.queryByTestId("sync-health-banner-calendar")).toBeNull();
  });

  it("Reconnect opens /?path=~integrations in a new tab (not a hash nav)", async () => {
    // Regression for the original UX bug — the button used to set
    // `window.location.hash = "#integrations"` which a) wasn't a real
    // route in the workspace router and b) ripped the user out of
    // their current tab. Correct behaviour is open in a new tab so
    // the user keeps their working context.
    global.fetch = mockStatusSequence(gmailReconnectBody()) as unknown as typeof fetch;
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const user = userEvent.setup();
    render(<SyncHealthBanner pollIntervalMs={1000} />);

    await waitFor(() =>
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /Reconnect$/ }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "/?path=~integrations",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("shows a generic 'sync failing' banner without a Reconnect CTA for non-OAuth errors", async () => {
    global.fetch = mockStatusSequence(
      gmailGenericErrorBody("Composio HTTP 502 — bad gateway"),
    ) as unknown as typeof fetch;
    render(<SyncHealthBanner pollIntervalMs={1000} />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument();
    });
    expect(screen.getByText(/Gmail sync failing/i)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 502/)).toBeInTheDocument();
    // No Reconnect CTA — only the Dismiss + close-X.
    expect(screen.queryByRole("button", { name: /Reconnect$/ })).toBeNull();
  });

  it("dismiss hides the banner for the same failure mode but it returns when the mode changes", async () => {
    const errA = gmailGenericErrorBody("Composio HTTP 502 — bad gateway");
    const errB = gmailGenericErrorBody("Composio HTTP 503 — service unavailable");
    global.fetch = mockStatusSequence(errA, errA, errB) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<SyncHealthBanner pollIntervalMs={20} />);

    await waitFor(() =>
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.queryByTestId("sync-health-banner-gmail")).toBeNull(),
    );

    // Wait for the next poll to flip the failure mode → banner returns.
    await waitFor(
      () => expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument(),
      { timeout: 2000 },
    );
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
  });

  it("does not surface a banner when the status endpoint itself fails", async () => {
    // Endpoint failures are an operator concern, not a Gmail/Calendar
    // failure — surfacing them as a sync error would be misleading.
    global.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    render(<SyncHealthBanner pollIntervalMs={1000} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("sync-health-banner-gmail")).toBeNull();
    expect(screen.queryByTestId("sync-health-banner-calendar")).toBeNull();
  });

  it("clears banner when a later poll reports success", async () => {
    global.fetch = mockStatusSequence(
      gmailReconnectBody(),
      cleanBody(),
    ) as unknown as typeof fetch;
    render(<SyncHealthBanner pollIntervalMs={20} />);

    await waitFor(() =>
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument(),
    );
    await waitFor(
      () => expect(screen.queryByTestId("sync-health-banner-gmail")).toBeNull(),
      { timeout: 2000 },
    );
  });

  it("renders both Gmail and Calendar banners when both fail", async () => {
    global.fetch = mockStatusSequence({
      gmail: {
        ...emptySource(),
        lastError: "Composio HTTP 500",
        lastErrorAt: new Date().toISOString(),
        lastSuccessAt: null,
        consecutiveFailures: 1,
        needsReconnect: false,
      },
      calendar: {
        ...emptySource(),
        lastError: "Composio HTTP 500 — calendar",
        lastErrorAt: new Date().toISOString(),
        lastSuccessAt: null,
        consecutiveFailures: 1,
        needsReconnect: false,
      },
      serverNow: new Date().toISOString(),
    }) as unknown as typeof fetch;

    render(<SyncHealthBanner pollIntervalMs={1000} />);

    await waitFor(() => {
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument();
      expect(screen.getByTestId("sync-health-banner-calendar")).toBeInTheDocument();
    });
  });

  it("shows a stale banner when no successful tick has happened in > 30min", async () => {
    global.fetch = mockStatusSequence({
      gmail: {
        ...emptySource(),
        lastError: null,
        lastErrorAt: null,
        lastSuccessAt: null,
        lastPolledAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        stale: true,
      },
      calendar: emptySource(),
      serverNow: new Date().toISOString(),
    }) as unknown as typeof fetch;

    render(<SyncHealthBanner pollIntervalMs={1000} />);

    await waitFor(() =>
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Gmail sync hasn't run recently/i)).toBeInTheDocument();
  });

  it("dismiss persists across re-mounts via sessionStorage", async () => {
    const err = gmailGenericErrorBody("Composio HTTP 500");
    global.fetch = mockStatusSequence(err, err, err, err) as unknown as typeof fetch;

    const user = userEvent.setup();
    const { unmount } = render(<SyncHealthBanner pollIntervalMs={1000} />);

    await waitFor(() =>
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.queryByTestId("sync-health-banner-gmail")).toBeNull(),
    );
    unmount();

    // Fresh mount with same fetch sequence → still hidden, because the
    // dismiss key is in sessionStorage.
    render(<SyncHealthBanner pollIntervalMs={1000} />);
    // Wait for the new mount's first poll to resolve.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.queryByTestId("sync-health-banner-gmail")).toBeNull();
  });

  // ---------------------------------------------------------------------
  // "Refresh now" button — same `/api/sync/refresh` route as the agent's
  // `denchclaw_refresh_sync` tool. The button must:
  //   1. POST to /api/sync/refresh with mode=incremental
  //   2. Show "Refreshing…" while the request is in flight
  //   3. After success, immediately re-poll /api/sync/status so the
  //      banner reflects the new state without waiting 60s
  //   4. On failure, show an inline error WITHOUT changing the title
  //      (which would alter the dismiss key)
  // ---------------------------------------------------------------------

  /**
   * Combined fetch mock for tests that exercise both `/api/sync/status`
   * (read-only) and `/api/sync/refresh` (action). Status uses the same
   * sequence semantics as `mockStatusSequence`; refresh uses a
   * controllable handler so tests can assert on the request body.
   */
  function mockFetchForRefresh(opts: {
    statusSequence: StatusBody[];
    refreshHandler?: (init: RequestInit | undefined) => Promise<Response> | Response;
  }): ReturnType<typeof vi.fn> {
    let i = 0;
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/sync/refresh")) {
        if (opts.refreshHandler) {
          return await opts.refreshHandler(init);
        }
        return new Response(JSON.stringify({ ok: true, mode: "incremental" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = opts.statusSequence[Math.min(i, opts.statusSequence.length - 1)] ?? cleanBody();
      i += 1;
      return jsonResponse(body);
    });
  }

  it("shows a 'Refresh now' button on every banner", async () => {
    global.fetch = mockFetchForRefresh({
      statusSequence: [gmailReconnectBody()],
    }) as unknown as typeof fetch;
    render(<SyncHealthBanner pollIntervalMs={1000} />);
    await waitFor(() =>
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("sync-health-refresh-gmail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh now/ })).toBeInTheDocument();
  });

  it("clicking 'Refresh now' POSTs /api/sync/refresh with mode=incremental and re-polls status", async () => {
    // The status sequence simulates: error → click refresh → next
    // poll returns clean → banner disappears.
    type RefreshHandler = (init: RequestInit | undefined) => Promise<Response>;
    const refreshHandler: ReturnType<typeof vi.fn<RefreshHandler>> = vi.fn(
      async (_init: RequestInit | undefined) =>
        new Response(
          JSON.stringify({
            ok: true,
            mode: "incremental",
            ranAt: new Date().toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    global.fetch = mockFetchForRefresh({
      statusSequence: [
        gmailGenericErrorBody("Composio HTTP 502"),
        cleanBody(),
      ],
      refreshHandler,
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<SyncHealthBanner pollIntervalMs={5000} />);

    await waitFor(() =>
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("sync-health-refresh-gmail"));

    // Refresh fetch fired with the right contract.
    await waitFor(() => expect(refreshHandler).toHaveBeenCalledTimes(1));
    const init = refreshHandler.mock.calls[0]?.[0];
    expect(init?.method).toBe("POST");
    // `init?.body` is `BodyInit | null | undefined` per the WHATWG
    // typings — Object.toString'ing it would produce "[object Object]"
    // for an arbitrary stream/blob. In our component the body is
    // always a string from `JSON.stringify`, so guard the type
    // explicitly rather than coercing through `String()`.
    const rawBody = init?.body;
    expect(typeof rawBody).toBe("string");
    expect(JSON.parse(rawBody as string)).toEqual({ mode: "incremental" });

    // Banner clears after the post-refresh status re-poll returns
    // clean — without this re-poll, users would have to wait up to
    // 60s for the banner to update.
    await waitFor(() =>
      expect(screen.queryByTestId("sync-health-banner-gmail")).toBeNull(),
    );
  });

  it("disables the button and shows 'Refreshing…' while a refresh is in flight", async () => {
    // Hold the refresh response open so we can observe the in-flight
    // state. Critical: a user mashing the button shouldn't fire a
    // second concurrent refresh.
    //
    // The TS-friendly way to share a promise resolver across the
    // closure boundary: use a deferred-like object so the type stays
    // `(value: Response) => void` rather than getting narrowed to `null`
    // by the assignment-inside-callback flow analysis.
    const deferred: { resolve: (value: Response) => void } = {
      resolve: () => {},
    };
    const refreshHandler = (): Promise<Response> =>
      new Promise<Response>((resolve) => {
        deferred.resolve = resolve;
      });
    global.fetch = mockFetchForRefresh({
      statusSequence: [gmailGenericErrorBody("Composio HTTP 500")],
      refreshHandler,
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<SyncHealthBanner pollIntervalMs={5000} />);

    await waitFor(() =>
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument(),
    );

    const button = screen.getByTestId("sync-health-refresh-gmail");
    await user.click(button);

    await waitFor(() => {
      expect(button.textContent).toMatch(/Refreshing/);
      // `disabled` is the property the browser reads at click time.
      // We assert via the attribute presence + the property to cover
      // both controlled-via-prop and styled-via-attribute paths.
      expect(button).toBeDisabled();
    });

    // Releasing the refresh resolves the promise; component flips
    // back to the idle state.
    deferred.resolve(
      new Response(JSON.stringify({ ok: true, mode: "incremental" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await waitFor(() => {
      const refreshed = screen.queryByTestId("sync-health-refresh-gmail");
      // Either the button reverted to "Refresh now" (banner still
      // visible because the second status poll also returned an error)
      // OR the banner went away (status came back clean). Both are
      // acceptable transitions out of in-flight.
      if (refreshed) {
        expect(refreshed.textContent).toMatch(/Refresh now/);
        expect(refreshed).not.toBeDisabled();
      }
    });
  });

  it("renders an inline error message when the refresh request fails", async () => {
    // Server returns a 500 → button transitions to error state and
    // shows the message under the action row. The banner title /
    // dismiss key MUST remain unchanged so the user's dismiss state
    // for the underlying sync error doesn't get accidentally cleared.
    global.fetch = mockFetchForRefresh({
      statusSequence: [gmailGenericErrorBody("Composio HTTP 502")],
      refreshHandler: () =>
        new Response(
          JSON.stringify({ error: "tickPoller threw: DuckDB busy" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<SyncHealthBanner pollIntervalMs={5000} />);

    await waitFor(() =>
      expect(screen.getByTestId("sync-health-banner-gmail")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("sync-health-refresh-gmail"));

    await waitFor(() => {
      expect(screen.getByTestId("sync-health-refresh-error-gmail")).toBeInTheDocument();
    });
    expect(screen.getByTestId("sync-health-refresh-error-gmail")).toHaveTextContent(
      /DuckDB busy/,
    );
    // Banner title unchanged — i.e., dismiss key still tied to the
    // underlying sync error, not to the refresh-failure event.
    expect(screen.getByText(/Gmail sync failing/)).toBeInTheDocument();
  });
});
