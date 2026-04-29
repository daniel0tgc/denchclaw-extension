import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let stateDir = "";

vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => stateDir),
}));

const {
  clearTransientOAuthFields,
  getMcpServerSecret,
  setMcpServerSecret,
} = await import("./mcp-secrets");

describe("mcp OAuth secrets", () => {
  beforeEach(() => {
    stateDir = path.join(os.tmpdir(), `dench-mcp-secrets-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("clears callback-only OAuth fields after token exchange", () => {
    setMcpServerSecret("acme", {
      clientId: "client-123",
      clientSecret: null,
      refreshToken: "refresh-123",
      tokenExpiresAt: "2026-04-29T01:00:00.000Z",
      asMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      authServerIssuer: "https://auth.example.com",
      registeredRedirectUri: "http://localhost:3100/api/settings/mcp/connect/callback",
      codeVerifier: "verifier-123",
      oauthState: "state-123",
      redirectUri: "http://localhost:3100/api/settings/mcp/connect/callback",
      scope: "mcp:read",
    });

    clearTransientOAuthFields("acme");

    expect(getMcpServerSecret("acme")).toEqual({
      clientId: "client-123",
      clientSecret: null,
      refreshToken: "refresh-123",
      tokenExpiresAt: "2026-04-29T01:00:00.000Z",
      asMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      authServerIssuer: "https://auth.example.com",
      registeredRedirectUri: "http://localhost:3100/api/settings/mcp/connect/callback",
      codeVerifier: null,
      oauthState: null,
      redirectUri: null,
      scope: "mcp:read",
    });
  });
});
