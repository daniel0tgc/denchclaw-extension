import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const {
  initiateComposioConnectMock,
  resolveComposioApiKeyMock,
  resolveComposioEligibilityMock,
  resolveComposioGatewayUrlMock,
} = vi.hoisted(() => ({
  initiateComposioConnectMock: vi.fn(),
  resolveComposioApiKeyMock: vi.fn(),
  resolveComposioEligibilityMock: vi.fn(),
  resolveComposioGatewayUrlMock: vi.fn(),
}));

vi.mock("@/lib/composio", () => ({
  initiateComposioConnect: initiateComposioConnectMock,
  resolveComposioApiKey: resolveComposioApiKeyMock,
  resolveComposioEligibility: resolveComposioEligibilityMock,
  resolveComposioGatewayUrl: resolveComposioGatewayUrlMock,
}));

describe("Composio connect API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveComposioApiKeyMock.mockReturnValue("dench_test_key");
    resolveComposioEligibilityMock.mockReturnValue({
      eligible: true,
      lockReason: null,
      lockBadge: null,
    });
    resolveComposioGatewayUrlMock.mockReturnValue("https://gateway.example.com");
    initiateComposioConnectMock.mockResolvedValue({
      redirect_url: "https://composio.example/connect/zoho",
    });
  });

  it("passes the selected toolkit slug and callback URL through to the gateway connect call", async () => {
    const response = await POST(
      new Request("http://localhost/api/composio/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          toolkit: "zoho",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(initiateComposioConnectMock).toHaveBeenCalledWith(
      "https://gateway.example.com",
      "dench_test_key",
      "zoho",
      "http://localhost/api/composio/callback",
    );
    expect(await response.json()).toEqual({
      redirect_url: "https://composio.example/connect/zoho",
      requested_toolkit: "zoho",
      connect_toolkit: "zoho",
    });
  });
});
