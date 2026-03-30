import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => "/home/testuser/.openclaw-dench"),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
}));

describe("integrations state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("normalizes Dench integration and search ownership state", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);

    mockExists.mockImplementation((path) => {
      const value = String(path);
      return (
        value.endsWith("openclaw.json") ||
        value.endsWith(".dench-integrations.json") ||
        value === "/home/testuser/.openclaw-dench/extensions/exa-search" ||
        value === "/home/testuser/.openclaw-dench/extensions/apollo-enrichment"
      );
    });

    mockRead.mockImplementation((path) => {
      const value = String(path);
      if (value.endsWith("openclaw.json")) {
        return JSON.stringify({
          models: {
            providers: {
              "dench-cloud": {
                apiKey: "dench-key",
              },
            },
          },
          messages: {
            tts: {
              elevenlabs: {
                baseUrl: "https://gateway.merseoriginals.com",
                apiKey: "dench-key",
              },
            },
          },
          plugins: {
            allow: ["exa-search", "apollo-enrichment"],
            load: {
              paths: [
                "/home/testuser/.openclaw-dench/extensions/exa-search",
                "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
              ],
            },
            entries: {
              "dench-ai-gateway": {
                enabled: true,
                config: {
                  gatewayUrl: "https://gateway.merseoriginals.com",
                },
              },
              "exa-search": {
                enabled: true,
              },
              "apollo-enrichment": {
                enabled: true,
              },
            },
            installs: {
              "exa-search": {
                installPath: "/home/testuser/.openclaw-dench/extensions/exa-search",
                sourcePath: "/repo/extensions/exa-search",
              },
              "apollo-enrichment": {
                installPath: "/home/testuser/.openclaw-dench/extensions/apollo-enrichment",
                sourcePath: "/repo/extensions/apollo-enrichment",
              },
            },
          },
          tools: {
            deny: ["web_search"],
            web: {
              search: {
                enabled: false,
                provider: "brave",
              },
            },
          },
        }) as never;
      }

      if (value.endsWith(".dench-integrations.json")) {
        return JSON.stringify({
          schemaVersion: 1,
          exa: {
            ownsSearch: true,
            fallbackProvider: "duckduckgo",
          },
        }) as never;
      }

      return "" as never;
    });

    const { getIntegrationsState } = await import("./integrations.js");
    const state = getIntegrationsState();
    expect(state.search).toEqual({
      builtIn: {
        enabled: false,
        denied: true,
        provider: "brave",
      },
      effectiveOwner: "exa",
    });
    expect(state.metadata.exa).toEqual({
      ownsSearch: true,
      fallbackProvider: "duckduckgo",
    });

    const exa = state.integrations.find((integration) => integration.id === "exa");
    const elevenlabs = state.integrations.find((integration) => integration.id === "elevenlabs");
    expect(exa).toMatchObject({
      enabled: true,
      available: true,
      gatewayBaseUrl: "https://gateway.merseoriginals.com",
      healthIssues: [],
    });
    expect(elevenlabs).toMatchObject({
      enabled: true,
      available: true,
      overrideActive: true,
      healthIssues: [],
    });
  });

  it("reports missing override and falls back to built-in search", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);
    const mockRead = vi.mocked(readFileSync);

    mockExists.mockImplementation((path) => String(path).endsWith("openclaw.json"));
    mockRead.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return JSON.stringify({
          plugins: {
            entries: {
              "exa-search": {
                enabled: false,
              },
            },
          },
          tools: {
            web: {
              search: {
                enabled: true,
                provider: "duckduckgo",
              },
            },
          },
        }) as never;
      }

      return "" as never;
    });

    const { getIntegrationsState } = await import("./integrations.js");
    const state = getIntegrationsState();
    expect(state.search.effectiveOwner).toBe("web_search");

    const exa = state.integrations.find((integration) => integration.id === "exa");
    const elevenlabs = state.integrations.find((integration) => integration.id === "elevenlabs");
    expect(exa?.healthIssues).toEqual(
      expect.arrayContaining([
        "plugin_disabled",
        "plugin_not_allowlisted",
        "plugin_load_path_missing",
        "plugin_install_missing",
        "missing_auth",
      ]),
    );
    expect(elevenlabs?.healthIssues).toEqual(
      expect.arrayContaining(["missing_auth", "missing_override"]),
    );
  });
});
