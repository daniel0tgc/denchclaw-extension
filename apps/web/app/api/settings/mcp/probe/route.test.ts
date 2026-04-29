import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp-servers", () => {
  class MockMcpServerError extends Error {
    status: number;

    constructor(status: number, message: string) {
      super(message);
      this.name = "McpServerError";
      this.status = status;
    }
  }

  return {
    getMcpServerConfig: vi.fn(),
    recordServerState: vi.fn(),
    setAuthorizationHeader: vi.fn(),
    McpServerError: MockMcpServerError,
  };
});

vi.mock("@/lib/mcp-probe", () => ({
  probeMcpServer: vi.fn(),
}));

vi.mock("@/lib/mcp-oauth", () => ({
  computeTokenExpiresAt: vi.fn(() => "2026-04-29T01:00:00.000Z"),
  discoverOAuthMetadata: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock("@/lib/mcp-secrets", () => ({
  getMcpServerSecret: vi.fn(),
  setMcpServerSecret: vi.fn(),
}));

vi.mock("@/lib/telemetry", () => ({
  trackServer: vi.fn(),
}));

const {
  getMcpServerConfig,
  McpServerError,
  recordServerState,
  setAuthorizationHeader,
} = await import("@/lib/mcp-servers");
const { probeMcpServer } = await import("@/lib/mcp-probe");
const {
  discoverOAuthMetadata,
  refreshAccessToken,
} = await import("@/lib/mcp-oauth");
const { getMcpServerSecret, setMcpServerSecret } = await import("@/lib/mcp-secrets");
const { trackServer } = await import("@/lib/telemetry");
const { POST } = await import("./route");

const mockedGetMcpServerConfig = vi.mocked(getMcpServerConfig);
const mockedProbeMcpServer = vi.mocked(probeMcpServer);
const mockedRecordServerState = vi.mocked(recordServerState);
const mockedSetAuthorizationHeader = vi.mocked(setAuthorizationHeader);
const mockedDiscoverOAuthMetadata = vi.mocked(discoverOAuthMetadata);
const mockedRefreshAccessToken = vi.mocked(refreshAccessToken);
const mockedGetMcpServerSecret = vi.mocked(getMcpServerSecret);
const mockedSetMcpServerSecret = vi.mocked(setMcpServerSecret);
const mockedTrackServer = vi.mocked(trackServer);

describe("POST /api/settings/mcp/probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates key field", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: 123 }),
    }));
    expect(response.status).toBe(400);
  });

  it("returns 404 when the server doesn't exist", async () => {
    mockedGetMcpServerConfig.mockReturnValue(null);
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "missing" }),
    }));
    expect(response.status).toBe(404);
  });

  it("propagates McpServerError status from getMcpServerConfig", async () => {
    mockedGetMcpServerConfig.mockImplementation(() => {
      throw new McpServerError(400, "Field 'key' must use only letters, numbers, hyphens, or underscores.");
    });
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "bad key" }),
    }));
    expect(response.status).toBe(400);
  });

  it("probes and records state on success", async () => {
    mockedGetMcpServerConfig.mockReturnValue({
      url: "https://mcp.example.com",
      transport: "streamable-http",
      headers: { Authorization: "Bearer abc" },
    });
    mockedProbeMcpServer.mockResolvedValue({
      status: "connected",
      toolCount: 4,
      authChallenge: null,
      detail: "Connected. 4 tools available.",
      checkedAt: "2026-04-29T00:00:00.000Z",
      httpStatus: 200,
    });
    mockedRecordServerState.mockReturnValue({
      key: "acme",
      url: "https://mcp.example.com",
      transport: "streamable-http",
      hasAuth: true,
      state: "connected",
      toolCount: 4,
      lastCheckedAt: "2026-04-29T00:00:00.000Z",
      lastDetail: "Connected. 4 tools available.",
    });

    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "acme" }),
    }));
    const body = await response.json();

    expect(mockedProbeMcpServer).toHaveBeenCalledWith({
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer abc" },
    });
    expect(mockedRecordServerState).toHaveBeenCalledWith("acme", {
      state: "connected",
      toolCount: 4,
      detail: "Connected. 4 tools available.",
      checkedAt: "2026-04-29T00:00:00.000Z",
    });
    expect(response.status).toBe(200);
    expect(body.server).toMatchObject({ state: "connected", toolCount: 4 });
    expect(body.probe.status).toBe("connected");
  });

  it("refreshes the OAuth token after invalid_token and re-probes", async () => {
    mockedGetMcpServerConfig
      .mockReturnValueOnce({
        url: "https://mcp.example.com",
        transport: "streamable-http",
        headers: { Authorization: "Bearer expired" },
      })
      .mockReturnValueOnce({
        url: "https://mcp.example.com",
        transport: "streamable-http",
        headers: { Authorization: "Bearer fresh" },
      });
    mockedProbeMcpServer
      .mockResolvedValueOnce({
        status: "needs_auth",
        toolCount: null,
        authChallenge: {
          scheme: "Bearer",
          realm: null,
          resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
          scope: null,
          errorCode: "invalid_token",
          errorDescription: "expired",
        },
        detail: "expired",
        checkedAt: "2026-04-29T00:00:00.000Z",
        httpStatus: 401,
      })
      .mockResolvedValueOnce({
        status: "connected",
        toolCount: 8,
        authChallenge: null,
        detail: "Connected. 8 tools available.",
        checkedAt: "2026-04-29T00:00:01.000Z",
        httpStatus: 200,
      });
    mockedGetMcpServerSecret.mockReturnValue({
      clientId: "client-123",
      clientSecret: null,
      refreshToken: "refresh-123",
      tokenExpiresAt: null,
      asMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      authServerIssuer: "https://auth.example.com",
      registeredRedirectUri: "http://localhost:3100/api/settings/mcp/connect/callback",
      codeVerifier: null,
      oauthState: null,
      redirectUri: null,
      scope: "mcp:read",
    });
    mockedDiscoverOAuthMetadata.mockResolvedValue({
      resource: {
        resource: "https://mcp.example.com",
        authorizationServers: ["https://auth.example.com"],
        scopesSupported: ["mcp:read"],
        bearerMethodsSupported: ["header"],
      },
      authServer: {
        issuer: "https://auth.example.com",
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        registrationEndpoint: "https://auth.example.com/register",
        scopesSupported: ["mcp:read"],
        responseTypesSupported: ["code"],
        grantTypesSupported: ["authorization_code"],
        codeChallengeMethodsSupported: ["S256"],
        tokenEndpointAuthMethodsSupported: ["none"],
      },
    });
    mockedRefreshAccessToken.mockResolvedValue({
      accessToken: "fresh",
      tokenType: "Bearer",
      refreshToken: "refresh-456",
      expiresIn: 3600,
      scope: "mcp:read",
    });
    mockedRecordServerState.mockReturnValue({
      key: "acme",
      url: "https://mcp.example.com",
      transport: "streamable-http",
      hasAuth: true,
      state: "connected",
      toolCount: 8,
      lastCheckedAt: "2026-04-29T00:00:01.000Z",
      lastDetail: "Connected. 8 tools available.",
    });

    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "acme" }),
    }));
    const body = await response.json();

    expect(mockedSetAuthorizationHeader).toHaveBeenCalledWith("acme", "Bearer fresh");
    expect(mockedSetMcpServerSecret).toHaveBeenCalledWith("acme", expect.objectContaining({
      refreshToken: "refresh-456",
      tokenExpiresAt: "2026-04-29T01:00:00.000Z",
    }));
    expect(mockedProbeMcpServer).toHaveBeenCalledTimes(2);
    expect(body.probe.status).toBe("connected");
    expect(body.probe.toolCount).toBe(8);
    expect(mockedTrackServer).toHaveBeenCalledWith("mcp_probe_refreshed", {
      key: "acme",
      success: true,
    });
  });

  it("clears the refresh token and keeps needs_auth when refresh fails", async () => {
    mockedGetMcpServerConfig.mockReturnValue({
      url: "https://mcp.example.com",
      transport: "streamable-http",
      headers: { Authorization: "Bearer expired" },
    });
    mockedProbeMcpServer.mockResolvedValue({
      status: "needs_auth",
      toolCount: null,
      authChallenge: {
        scheme: "Bearer",
        realm: null,
        resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
        scope: null,
        errorCode: "invalid_token",
        errorDescription: "expired",
      },
      detail: "expired",
      checkedAt: "2026-04-29T00:00:00.000Z",
      httpStatus: 401,
    });
    mockedGetMcpServerSecret.mockReturnValue({
      clientId: "client-123",
      clientSecret: null,
      refreshToken: "refresh-123",
      tokenExpiresAt: null,
      asMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      authServerIssuer: "https://auth.example.com",
      registeredRedirectUri: "http://localhost:3100/api/settings/mcp/connect/callback",
      codeVerifier: null,
      oauthState: null,
      redirectUri: null,
      scope: "mcp:read",
    });
    mockedDiscoverOAuthMetadata.mockRejectedValue(new Error("refresh metadata failed"));
    mockedRecordServerState.mockReturnValue({
      key: "acme",
      url: "https://mcp.example.com",
      transport: "streamable-http",
      hasAuth: true,
      state: "needs_auth",
      toolCount: null,
      lastCheckedAt: "2026-04-29T00:00:00.000Z",
      lastDetail: "refresh metadata failed",
    });

    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "acme" }),
    }));
    const body = await response.json();

    expect(mockedSetMcpServerSecret).toHaveBeenCalledWith("acme", {
      refreshToken: null,
      tokenExpiresAt: null,
    });
    expect(mockedRecordServerState).toHaveBeenCalledWith("acme", expect.objectContaining({
      state: "needs_auth",
      detail: "refresh metadata failed",
    }));
    expect(body.probe.status).toBe("needs_auth");
  });
});
