import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/integrations", () => ({
  setExaIntegrationEnabled: vi.fn((enabled: boolean) => ({
    changed: true,
    state: {
      metadata: { schemaVersion: 1, exa: { ownsSearch: enabled, fallbackProvider: "duckduckgo" } },
      search: {
        builtIn: {
          enabled: !enabled,
          denied: enabled,
          provider: enabled ? "duckduckgo" : "duckduckgo",
        },
        effectiveOwner: enabled ? "exa" : "web_search",
      },
      integrations: [],
    },
  })),
  setApolloIntegrationEnabled: vi.fn((enabled: boolean) => ({
    changed: true,
    state: {
      metadata: { schemaVersion: 1, exa: { ownsSearch: false, fallbackProvider: "duckduckgo" } },
      search: {
        builtIn: {
          enabled: true,
          denied: false,
          provider: "duckduckgo",
        },
        effectiveOwner: "web_search",
      },
      integrations: [{ id: "apollo", enabled, available: true }],
    },
  })),
  setElevenLabsIntegrationEnabled: vi.fn((enabled: boolean) => ({
    changed: true,
    state: {
      metadata: { schemaVersion: 1, exa: { ownsSearch: false, fallbackProvider: "duckduckgo" } },
      search: {
        builtIn: {
          enabled: true,
          denied: false,
          provider: "duckduckgo",
        },
        effectiveOwner: "web_search",
      },
      integrations: [{ id: "elevenlabs", enabled, available: true }],
    },
  })),
}));

describe("integrations toggle API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("toggles Exa integration", async () => {
    const { POST } = await import("./route.js");
    const request = new Request("http://localhost/api/integrations/exa/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "exa" }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.integration).toBe("exa");
    expect(json.search.effectiveOwner).toBe("exa");
  });

  it("rejects missing enabled boolean", async () => {
    const { POST } = await import("./route.js");
    const request = new Request("http://localhost/api/integrations/exa/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "exa" }) });
    expect(response.status).toBe(400);
  });

  it("toggles Apollo integration", async () => {
    const { POST } = await import("./route.js");
    const request = new Request("http://localhost/api/integrations/apollo/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "apollo" }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.integration).toBe("apollo");
  });

  it("toggles ElevenLabs integration", async () => {
    const { POST } = await import("./route.js");
    const request = new Request("http://localhost/api/integrations/elevenlabs/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "elevenlabs" }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.integration).toBe("elevenlabs");
  });
});
