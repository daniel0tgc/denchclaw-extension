import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { invalidateComposioConnectionsCacheMock } = vi.hoisted(() => ({
  invalidateComposioConnectionsCacheMock: vi.fn(),
}));

vi.mock("../connections/cache", () => ({
  invalidateComposioConnectionsCache: invalidateComposioConnectionsCacheMock,
}));

vi.mock("@/lib/integrations", () => ({
  refreshIntegrationsRuntime: vi.fn(),
}));

vi.mock("@/lib/composio", () => ({
  fetchComposioConnections: vi.fn(),
  resolveComposioApiKey: vi.fn(() => "dench_test_key"),
  resolveComposioGatewayUrl: vi.fn(() => "https://gateway.example.com"),
}));

const { refreshIntegrationsRuntime } = await import("@/lib/integrations");
const { fetchComposioConnections } = await import("@/lib/composio");

const mockedRefreshIntegrationsRuntime = vi.mocked(refreshIntegrationsRuntime);
const mockedFetchComposioConnections = vi.mocked(fetchComposioConnections);

const ORIGINAL_PUBLIC_URL = process.env.DENCHCLAW_PUBLIC_URL;

describe("Composio callback API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DENCHCLAW_PUBLIC_URL;
    mockedRefreshIntegrationsRuntime.mockResolvedValue({
      attempted: true,
      restarted: true,
      error: null,
      profile: "dench",
    });
    mockedFetchComposioConnections.mockResolvedValue({
      connections: [
        {
          id: "acct_123",
          toolkit_slug: "twitter",
          toolkit_name: "Twitter",
          status: "ACTIVE",
          created_at: "2026-04-02T00:00:00.000Z",
        },
      ],
    } as never);
  });

  afterEach(() => {
    if (ORIGINAL_PUBLIC_URL === undefined) {
      delete process.env.DENCHCLAW_PUBLIC_URL;
    } else {
      process.env.DENCHCLAW_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
    }
  });

  it("refreshes the runtime after a successful connection", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/composio/callback?status=success&connected_account_id=acct_123",
      ),
    );

    const html = await response.text();
    expect(response.status).toBe(200);
    expect(invalidateComposioConnectionsCacheMock).toHaveBeenCalledTimes(1);
    expect(mockedRefreshIntegrationsRuntime).toHaveBeenCalledTimes(1);
    expect(html).toContain('"connected_account_id":"acct_123"');
    expect(html).toContain('"connected_toolkit_slug":"x"');
    expect(html).toContain('"connected_toolkit_name":"X"');
  });

  it("does not rebuild when the callback is unsuccessful", async () => {
    const response = await GET(
      new Request("http://localhost/api/composio/callback?status=error"),
    );

    expect(response.status).toBe(200);
    expect(invalidateComposioConnectionsCacheMock).not.toHaveBeenCalled();
    expect(mockedRefreshIntegrationsRuntime).not.toHaveBeenCalled();
  });

  it("inlines the request.url origin as targetOrigin in local dev (no proxy, no env)", async () => {
    const response = await GET(
      new Request(
        "http://localhost:3100/api/composio/callback?status=success&connected_account_id=acct_123",
      ),
    );

    const html = await response.text();
    expect(html).toContain('"http://localhost:3100"');
  });

  it("uses DENCHCLAW_PUBLIC_URL as targetOrigin so postMessage matches the parent tab origin", async () => {
    process.env.DENCHCLAW_PUBLIC_URL =
      "https://acme.sandbox.merseoriginals.com";

    const response = await GET(
      new Request(
        "http://localhost:3100/api/composio/callback?status=success&connected_account_id=acct_123",
      ),
    );

    const html = await response.text();
    expect(html).toContain('"https://acme.sandbox.merseoriginals.com"');
    expect(html).not.toContain('"http://localhost:3100"');
  });

  it("prefers X-Forwarded-Host so the postMessage targetOrigin reflects the actual public host", async () => {
    process.env.DENCHCLAW_PUBLIC_URL = "https://stale.sandbox.merseoriginals.com";

    const response = await GET(
      new Request(
        "http://localhost:3100/api/composio/callback?status=success&connected_account_id=acct_123",
        {
          headers: {
            "x-forwarded-host": "real-org.sandbox.merseoriginals.com",
            "x-forwarded-proto": "https",
          },
        },
      ),
    );

    const html = await response.text();
    expect(html).toContain('"https://real-org.sandbox.merseoriginals.com"');
    expect(html).not.toContain('"https://stale.sandbox.merseoriginals.com"');
  });
});
