import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let stateDir = "";

vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => stateDir),
}));

vi.mock("@/lib/mcp-servers", () => ({
  getMcpServerConfig: vi.fn(),
  recordServerState: vi.fn(),
  setAuthorizationHeader: vi.fn(),
}));

vi.mock("@/lib/mcp-probe", () => ({
  probeMcpServer: vi.fn(),
}));

vi.mock("@/lib/mcp-oauth", () => ({
  computeTokenExpiresAt: vi.fn(() => "2026-04-29T01:00:00.000Z"),
  discoverOAuthMetadata: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  McpOAuthError: class MockMcpOAuthError extends Error {
    reason: string;

    constructor(reason: string, message?: string) {
      super(message ?? reason);
      this.reason = reason;
    }
  },
}));

vi.mock("@/lib/mcp-secrets", () => ({
  clearTransientOAuthFields: vi.fn(),
  getMcpServerSecret: vi.fn(),
  setMcpServerSecret: vi.fn(),
}));

vi.mock("@/lib/public-origin", () => ({
  resolveAppPublicOrigin: vi.fn(() => "http://localhost:3100"),
}));

vi.mock("@/lib/telemetry", () => ({
  trackServer: vi.fn(),
}));

const {
  getMcpServerConfig,
  recordServerState,
  setAuthorizationHeader,
} = await import("@/lib/mcp-servers");
const { probeMcpServer } = await import("@/lib/mcp-probe");
const {
  discoverOAuthMetadata,
  exchangeCodeForToken,
} = await import("@/lib/mcp-oauth");
const {
  clearTransientOAuthFields,
  getMcpServerSecret,
  setMcpServerSecret,
} = await import("@/lib/mcp-secrets");
const { trackServer } = await import("@/lib/telemetry");
const { GET } = await import("./route");

const mockedGetMcpServerConfig = vi.mocked(getMcpServerConfig);
const mockedRecordServerState = vi.mocked(recordServerState);
const mockedSetAuthorizationHeader = vi.mocked(setAuthorizationHeader);
const mockedProbeMcpServer = vi.mocked(probeMcpServer);
const mockedDiscoverOAuthMetadata = vi.mocked(discoverOAuthMetadata);
const mockedExchangeCodeForToken = vi.mocked(exchangeCodeForToken);
const mockedClearTransientOAuthFields = vi.mocked(clearTransientOAuthFields);
const mockedGetMcpServerSecret = vi.mocked(getMcpServerSecret);
const mockedSetMcpServerSecret = vi.mocked(setMcpServerSecret);
const mockedTrackServer = vi.mocked(trackServer);

function writeSecrets(contents: Record<string, unknown>) {
  writeFileSync(
    path.join(stateDir, ".mcp-secrets.json"),
    JSON.stringify(contents, null, 2),
    "utf-8",
  );
}

describe("GET /api/settings/mcp/connect/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = path.join(os.tmpdir(), `dench-mcp-callback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("rejects unknown state", async () => {
    writeSecrets({});

    const response = await GET(new Request(
      "http://localhost/api/settings/mcp/connect/callback?code=code-123&state=missing",
    ));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Connection failed");
    expect(html).toContain("unknown_state");
  });

  it("persists tokens, writes Authorization header, probes, and posts success", async () => {
    writeSecrets({
      acme: { oauthState: "state-123" },
    });
    mockedGetMcpServerSecret.mockReturnValue({
      clientId: "client-123",
      clientSecret: null,
      refreshToken: null,
      tokenExpiresAt: null,
      asMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      authServerIssuer: "https://auth.example.com",
      registeredRedirectUri: "http://localhost:3100/api/settings/mcp/connect/callback",
      codeVerifier: "verifier-123",
      oauthState: "state-123",
      redirectUri: "http://localhost:3100/api/settings/mcp/connect/callback",
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
    mockedExchangeCodeForToken.mockResolvedValue({
      accessToken: "access-123",
      tokenType: "Bearer",
      refreshToken: "refresh-123",
      expiresIn: 3600,
      scope: "mcp:read",
    });
    mockedGetMcpServerConfig.mockReturnValue({
      url: "https://mcp.example.com",
      transport: "streamable-http",
      headers: { Authorization: "Bearer access-123" },
    });
    mockedProbeMcpServer.mockResolvedValue({
      status: "connected",
      toolCount: 7,
      authChallenge: null,
      detail: "Connected. 7 tools available.",
      checkedAt: "2026-04-29T00:00:00.000Z",
      httpStatus: 200,
    });

    const response = await GET(new Request(
      "http://localhost/api/settings/mcp/connect/callback?code=code-123&state=state-123",
    ));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(mockedExchangeCodeForToken).toHaveBeenCalledWith(expect.objectContaining({
      code: "code-123",
      codeVerifier: "verifier-123",
    }));
    expect(mockedSetAuthorizationHeader).toHaveBeenCalledWith("acme", "Bearer access-123");
    expect(mockedSetMcpServerSecret).toHaveBeenCalledWith("acme", expect.objectContaining({
      refreshToken: "refresh-123",
      tokenExpiresAt: "2026-04-29T01:00:00.000Z",
    }));
    expect(mockedClearTransientOAuthFields).toHaveBeenCalledWith("acme");
    expect(mockedRecordServerState).toHaveBeenCalledWith("acme", expect.objectContaining({
      state: "connected",
      toolCount: 7,
    }));
    expect(mockedTrackServer).toHaveBeenCalledWith("mcp_connect_completed", { key: "acme" });
    expect(html).toContain("mcp-connected");
    expect(html).toContain("Connected acme");
  });
});
