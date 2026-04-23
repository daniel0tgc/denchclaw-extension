import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const ORIGINAL_PUBLIC_URL = process.env.DENCHCLAW_PUBLIC_URL;

describe("Composio connect API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DENCHCLAW_PUBLIC_URL;
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

  afterEach(() => {
    if (ORIGINAL_PUBLIC_URL === undefined) {
      delete process.env.DENCHCLAW_PUBLIC_URL;
    } else {
      process.env.DENCHCLAW_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
    }
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

  it("uses DENCHCLAW_PUBLIC_URL for the callback origin when set (Dench Cloud sandbox)", async () => {
    process.env.DENCHCLAW_PUBLIC_URL =
      "https://dench-com.sandbox.merseoriginals.com";

    const response = await POST(
      new Request("http://localhost/api/composio/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolkit: "zoho" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(initiateComposioConnectMock).toHaveBeenCalledWith(
      "https://gateway.example.com",
      "dench_test_key",
      "zoho",
      "https://dench-com.sandbox.merseoriginals.com/api/composio/callback",
    );
  });

  it("prefers X-Forwarded-* headers over DENCHCLAW_PUBLIC_URL — needed for warm-pool rebinds where the running container has a stale env value", async () => {
    process.env.DENCHCLAW_PUBLIC_URL =
      "https://stale-warm-pool-slug.sandbox.merseoriginals.com";

    const response = await POST(
      new Request("http://localhost/api/composio/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-host": "real-org.sandbox.merseoriginals.com",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify({ toolkit: "zoho" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(initiateComposioConnectMock).toHaveBeenCalledWith(
      "https://gateway.example.com",
      "dench_test_key",
      "zoho",
      "https://real-org.sandbox.merseoriginals.com/api/composio/callback",
    );
  });
});
