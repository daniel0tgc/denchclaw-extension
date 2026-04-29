import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let stateDir = "";

vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => stateDir),
}));

const {
  addMcpServer,
  removeMcpServer,
  setAuthorizationHeader,
} = await import("./mcp-servers");
const {
  getMcpServerSecret,
  setMcpServerSecret,
} = await import("./mcp-secrets");

function configPath(): string {
  return path.join(stateDir, "openclaw.json");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
}

describe("mcp server config helpers", () => {
  beforeEach(() => {
    stateDir = path.join(os.tmpdir(), `dench-mcp-servers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("refuses to add the reserved composio key", () => {
    expect(() => {
      addMcpServer({
        key: "composio",
        url: "https://mcp.example.com",
      });
    }).toThrow("managed internally");
  });

  it("does not mutate the reserved composio runtime server", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        mcp: {
          servers: {
            composio: {
              url: "https://gateway.example.com/v1/composio/mcp",
              transport: "streamable-http",
            },
            acme: {
              url: "https://mcp.example.com",
              transport: "streamable-http",
            },
          },
        },
      }),
      "utf-8",
    );

    expect(() => setAuthorizationHeader("composio", "Bearer nope")).toThrow("managed internally");
    expect(() => removeMcpServer("composio")).toThrow("managed internally");

    const config = readConfig() as {
      mcp: { servers: Record<string, { url: string; transport: string }> };
    };
    expect(config.mcp.servers.composio).toEqual({
      url: "https://gateway.example.com/v1/composio/mcp",
      transport: "streamable-http",
    });
    expect(config.mcp.servers.acme).toEqual({
      url: "https://mcp.example.com",
      transport: "streamable-http",
    });
  });

  it("deletes OAuth secrets when removing a server", () => {
    addMcpServer({
      key: "acme",
      url: "https://mcp.example.com",
    });
    setMcpServerSecret("acme", {
      clientId: "client-123",
      refreshToken: "refresh-123",
      asMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      codeVerifier: "verifier-123",
      oauthState: "state-123",
    });

    removeMcpServer("acme");

    expect(getMcpServerSecret("acme")).toBeNull();
  });
});
