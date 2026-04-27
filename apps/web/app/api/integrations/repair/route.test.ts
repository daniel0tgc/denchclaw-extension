import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/integrations", () => ({
  repairManagedPluginsProfile: vi.fn(() => ({
    changed: true,
    repairs: [
      {
        id: "dench-ai-gateway",
        pluginId: "dench-ai-gateway",
        assetAvailable: true,
        assetCopied: true,
        repaired: true,
        issues: [],
      },
    ],
    repairedIds: ["dench-ai-gateway"],
    state: {
      denchCloud: {
        hasKey: true,
        isPrimaryProvider: true,
        primaryModel: "dench-cloud/claude-sonnet-4.6",
      },
      metadata: { schemaVersion: 1, exa: { ownsSearch: false, fallbackProvider: "duckduckgo" } },
      search: {
        builtIn: {
          enabled: true,
          denied: false,
          provider: "duckduckgo",
        },
        effectiveOwner: "web_search",
      },
      managedPlugins: [],
      integrations: [],
    },
  })),
  refreshIntegrationsRuntime: vi.fn(() => Promise.resolve({
    attempted: true,
    restarted: true,
    error: null,
    profile: "dench",
  })),
}));

describe("integrations repair API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("repairs older profiles and reports restart status", async () => {
    const { POST } = await import("./route.js");
    const response = await POST();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.changed).toBe(true);
    expect(json.repairedIds).toEqual(["dench-ai-gateway"]);
    expect(json.refresh.restarted).toBe(true);
  });
});
