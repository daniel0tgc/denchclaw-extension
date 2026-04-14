import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

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

describe("Composio callback API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("refreshes the runtime after a successful connection", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/composio/callback?status=success&connected_account_id=acct_123",
      ),
    );

    const html = await response.text();
    expect(response.status).toBe(200);
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
    expect(mockedRefreshIntegrationsRuntime).not.toHaveBeenCalled();
  });
});
