import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";

function writeAuthProfiles(stateDir: string, key: string): void {
  const authDir = path.join(stateDir, "agents", "main", "agent");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(
    path.join(authDir, "auth-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: {
        "dench-cloud:default": { type: "api_key", provider: "dench-cloud", key },
      },
    }),
  );
}

function writeOpenClawConfig(stateDir: string, enrichmentMaxMode: boolean): void {
  writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      models: {
        providers: {
          "dench-cloud": {
            enrichmentMaxMode,
          },
        },
      },
    }),
  );
}

function createApi() {
  const tools: any[] = [];
  return {
    api: {
      config: {
        plugins: {
          entries: {
            "dench-ai-gateway": {
              config: {
                enabled: true,
                gatewayUrl: "https://gateway.example.com",
              },
            },
          },
        },
      },
      registerTool(tool: any) {
        tools.push(tool);
      },
      logger: {
        info: vi.fn(),
      },
    },
    tools,
  };
}

describe("apollo-enrichment max mode", () => {
  const originalFetch = globalThis.fetch;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string | undefined;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (stateDir) {
      rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
    if (originalStateDir !== undefined) {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    } else {
      delete process.env.OPENCLAW_STATE_DIR;
    }
  });

  it("forwards mode=max to people enrichment when enabled", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "apollo-enrichment-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");
    writeOpenClawConfig(stateDir, true);

    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://gateway.example.com/v1/enrichment/people");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        email: "jane@acme.com",
        mode: "max",
      });
      return new Response(JSON.stringify({ person: { id: "p1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { api, tools } = createApi();
    register(api);

    expect(tools).toHaveLength(1);
    await tools[0].execute("call_1", {
      action: "people",
      email: "jane@acme.com",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("forwards mode=max to company enrichment when enabled", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "apollo-enrichment-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");
    writeOpenClawConfig(stateDir, true);

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://gateway.example.com/v1/enrichment/company");
      expect(url.searchParams.get("domain")).toBe("acme.com");
      expect(url.searchParams.get("mode")).toBe("max");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ organization: { id: "o1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { api, tools } = createApi();
    register(api);

    expect(tools).toHaveLength(1);
    await tools[0].execute("call_1", {
      action: "company",
      domain: "acme.com",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
