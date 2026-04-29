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
    listMcpServers: vi.fn(),
    addMcpServer: vi.fn(),
    removeMcpServer: vi.fn(),
    getMcpServerConfig: vi.fn(),
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
  addMcpServer,
  getMcpServerConfig,
  listMcpServers,
  McpServerError,
  recordServerState,
  removeMcpServer,
} = await import("@/lib/mcp-servers");
const { probeMcpServer } = await import("@/lib/mcp-probe");
const { trackServer } = await import("@/lib/telemetry");
const { DELETE, GET, POST } = await import("./route");

const mockedAddMcpServer = vi.mocked(addMcpServer);
const mockedGetMcpServerConfig = vi.mocked(getMcpServerConfig);
const mockedListMcpServers = vi.mocked(listMcpServers);
const mockedRemoveMcpServer = vi.mocked(removeMcpServer);
const mockedRecordServerState = vi.mocked(recordServerState);
const mockedProbeMcpServer = vi.mocked(probeMcpServer);
const mockedTrackServer = vi.mocked(trackServer);

const baseEntry = {
  key: "acme",
  url: "https://mcp.example.com",
  transport: "streamable-http",
  hasAuth: false,
  state: "untested" as const,
  toolCount: null,
  lastCheckedAt: null,
  lastDetail: null,
};

describe("MCP settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET returns configured MCP servers", async () => {
    mockedListMcpServers.mockReturnValue([
      { ...baseEntry, hasAuth: true, state: "connected", toolCount: 5 },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.servers).toEqual([
      {
        ...baseEntry,
        hasAuth: true,
        state: "connected",
        toolCount: 5,
      },
    ]);
  });

  it("GET returns 500 when listing fails", async () => {
    mockedListMcpServers.mockImplementation(() => {
      throw new Error("read failed");
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain("read failed");
  });

  it("POST validates key type", async () => {
    const response = await POST(new Request("http://localhost/api/settings/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: 123,
        url: "https://mcp.example.com",
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Field 'key' must be a string.",
    });
  });

  it("POST creates a server, runs an immediate probe, and returns the post-probe entry", async () => {
    mockedAddMcpServer.mockReturnValue({ ...baseEntry });
    mockedGetMcpServerConfig.mockReturnValue({
      url: "https://mcp.example.com",
      transport: "streamable-http",
    });
    mockedProbeMcpServer.mockResolvedValue({
      status: "needs_auth",
      toolCount: null,
      authChallenge: null,
      detail: "HTTP 401 from MCP server.",
      checkedAt: "2026-04-29T00:00:00.000Z",
      httpStatus: 401,
    });
    mockedRecordServerState.mockReturnValue({
      ...baseEntry,
      state: "needs_auth",
      lastDetail: "HTTP 401 from MCP server.",
      lastCheckedAt: "2026-04-29T00:00:00.000Z",
    });

    const response = await POST(new Request("http://localhost/api/settings/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "acme",
        url: "https://mcp.example.com",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockedAddMcpServer).toHaveBeenCalledWith({
      key: "acme",
      url: "https://mcp.example.com",
      transport: undefined,
    });
    expect(mockedProbeMcpServer).toHaveBeenCalledWith({
      url: "https://mcp.example.com",
      headers: undefined,
    });
    expect(mockedRecordServerState).toHaveBeenCalledWith("acme", {
      state: "needs_auth",
      toolCount: null,
      detail: "HTTP 401 from MCP server.",
      checkedAt: "2026-04-29T00:00:00.000Z",
    });
    expect(body.server).toMatchObject({
      key: "acme",
      state: "needs_auth",
      lastDetail: "HTTP 401 from MCP server.",
    });
    expect(mockedTrackServer).toHaveBeenCalledWith("mcp_server_added", {
      key: "acme",
      transport: "streamable-http",
      has_auth: false,
    });
  });

  it("POST still returns 201 when the post-create probe blows up", async () => {
    mockedAddMcpServer.mockReturnValue({ ...baseEntry });
    mockedGetMcpServerConfig.mockReturnValue(null);

    const response = await POST(new Request("http://localhost/api/settings/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "acme",
        url: "https://mcp.example.com",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.server).toMatchObject({ key: "acme", state: "untested" });
    expect(mockedProbeMcpServer).not.toHaveBeenCalled();
  });

  it("POST returns helper validation errors", async () => {
    mockedAddMcpServer.mockImplementation(() => {
      throw new McpServerError(409, "MCP server 'acme' already exists.");
    });

    const response = await POST(new Request("http://localhost/api/settings/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "acme",
        url: "https://mcp.example.com",
      }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "MCP server 'acme' already exists.",
    });
    expect(mockedTrackServer).not.toHaveBeenCalled();
  });

  it("DELETE validates key type", async () => {
    const response = await DELETE(new Request("http://localhost/api/settings/mcp", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: 123 }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Field 'key' must be a string.",
    });
  });

  it("DELETE removes the requested server", async () => {
    const response = await DELETE(new Request("http://localhost/api/settings/mcp", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "acme" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockedRemoveMcpServer).toHaveBeenCalledWith("acme");
    expect(body).toEqual({ key: "acme" });
    expect(mockedTrackServer).toHaveBeenCalledWith("mcp_server_removed", {
      key: "acme",
    });
  });

  it("DELETE returns helper not-found errors", async () => {
    mockedRemoveMcpServer.mockImplementation(() => {
      throw new McpServerError(404, "MCP server 'missing' was not found.");
    });

    const response = await DELETE(new Request("http://localhost/api/settings/mcp", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "missing" }),
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "MCP server 'missing' was not found.",
    });
    expect(mockedTrackServer).not.toHaveBeenCalled();
  });
});
