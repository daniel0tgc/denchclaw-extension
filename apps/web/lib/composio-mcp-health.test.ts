import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchComposioMcpToolsListMock,
  refreshIntegrationsRuntimeMock,
  resolveOpenClawStateDirMock,
} = vi.hoisted(() => ({
  fetchComposioMcpToolsListMock: vi.fn(),
  refreshIntegrationsRuntimeMock: vi.fn(),
  resolveOpenClawStateDirMock: vi.fn(),
}));

vi.mock("@/lib/composio", () => ({
  fetchComposioMcpToolsList: fetchComposioMcpToolsListMock,
  resolveComposioApiKey: vi.fn(() => "dench_test_key"),
  resolveComposioEligibility: vi.fn(() => ({
    eligible: true,
    lockReason: null,
    lockBadge: null,
  })),
  resolveComposioGatewayUrl: vi.fn(() => "https://gateway.example.com"),
}));

vi.mock("@/lib/integrations", () => ({
  refreshIntegrationsRuntime: refreshIntegrationsRuntimeMock,
}));

vi.mock("@/lib/workspace", () => ({
  resolveActiveAgentId: vi.fn(() => "main"),
  resolveOpenClawStateDir: resolveOpenClawStateDirMock,
  resolveWorkspaceRoot: vi.fn(() => "/tmp/workspace"),
}));

vi.mock("@/lib/agent-runner", () => ({
  spawnAgentStartForSession: vi.fn(),
}));

vi.mock("../../../src/cli/dench-cloud", () => ({
  buildComposioMcpServerConfig: vi.fn((gatewayUrl: string, apiKey: string) => ({
    url: `${gatewayUrl}/v1/composio/mcp`,
    transport: "streamable-http",
    headers: { Authorization: `Bearer ${apiKey}` },
  })),
}));

const { getComposioMcpHealth } = await import("./composio-mcp-health");

describe("Composio MCP health", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = mkdtempSync(join(tmpdir(), "dench-composio-health-"));
    resolveOpenClawStateDirMock.mockReturnValue(stateDir);
    fetchComposioMcpToolsListMock.mockResolvedValue([{ name: "GMAIL_FETCH_EMAILS" }]);
    refreshIntegrationsRuntimeMock.mockResolvedValue({
      attempted: true,
      restarted: true,
      error: null,
      profile: "dench",
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("self-heals a missing composio MCP server during status refresh", async () => {
    writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify({ mcp: { servers: {} } }));

    const health = await getComposioMcpHealth({ autoRepairConfig: true });
    const config = JSON.parse(readFileSync(join(stateDir, "openclaw.json"), "utf-8")) as {
      mcp?: {
        servers?: {
          composio?: {
            url?: string;
            transport?: string;
            headers?: { Authorization?: string };
          };
        };
      };
    };

    expect(config.mcp?.servers?.composio).toEqual({
      url: "https://gateway.example.com/v1/composio/mcp",
      transport: "streamable-http",
      headers: { Authorization: "Bearer dench_test_key" },
    });
    expect(health.config.status).toBe("pass");
    expect(health.summary.level).toBe("healthy");
    expect(health.liveAgent.detail).toMatch(/Configuration repaired/);
    expect(refreshIntegrationsRuntimeMock).toHaveBeenCalledTimes(1);
  });
});
