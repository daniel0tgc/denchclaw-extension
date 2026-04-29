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
    setAuthorizationHeader: vi.fn(),
    recordServerState: vi.fn(),
    McpServerError: MockMcpServerError,
  };
});

vi.mock("@/lib/mcp-probe", () => ({
  probeMcpServer: vi.fn(),
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
const { trackServer } = await import("@/lib/telemetry");
const { POST } = await import("./route");

const mockedGetMcpServerConfig = vi.mocked(getMcpServerConfig);
const mockedProbeMcpServer = vi.mocked(probeMcpServer);
const mockedRecordServerState = vi.mocked(recordServerState);
const mockedSetAuthorizationHeader = vi.mocked(setAuthorizationHeader);
const mockedTrackServer = vi.mocked(trackServer);

const baseEntry = {
  key: "acme",
  url: "https://mcp.example.com",
  transport: "streamable-http",
  hasAuth: true,
  state: "connected" as const,
  toolCount: 2,
  lastCheckedAt: "2026-04-29T00:00:00.000Z",
  lastDetail: "Connected. 2 tools available.",
};

describe("POST /api/settings/mcp/connect/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing key", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authToken: "abc" }),
    }));
    expect(response.status).toBe(400);
  });

  it("rejects empty authToken", async () => {
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "acme", authToken: "  " }),
    }));
    expect(response.status).toBe(400);
  });

  it("strips a leading 'Bearer ' prefix from the supplied token", async () => {
    mockedSetAuthorizationHeader.mockReturnValue(baseEntry);
    mockedGetMcpServerConfig.mockReturnValue({
      url: "https://mcp.example.com",
      transport: "streamable-http",
      headers: { Authorization: "Bearer abc" },
    });
    mockedProbeMcpServer.mockResolvedValue({
      status: "connected",
      toolCount: 2,
      authChallenge: null,
      detail: "Connected. 2 tools available.",
      checkedAt: "2026-04-29T00:00:00.000Z",
      httpStatus: 200,
    });
    mockedRecordServerState.mockReturnValue(baseEntry);

    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "acme", authToken: "Bearer abc" }),
    }));

    expect(mockedSetAuthorizationHeader).toHaveBeenCalledWith("acme", "Bearer abc");
    expect(response.status).toBe(200);
    expect(mockedTrackServer).toHaveBeenCalledWith("mcp_server_token_set", {
      key: "acme",
      probe_status: "connected",
    });
  });

  it("propagates McpServerError when the server doesn't exist", async () => {
    mockedSetAuthorizationHeader.mockImplementation(() => {
      throw new McpServerError(404, "MCP server 'missing' was not found.");
    });

    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "missing", authToken: "abc" }),
    }));
    expect(response.status).toBe(404);
  });
});
