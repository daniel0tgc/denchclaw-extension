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

function writeOpenClawConfig(stateDir: string): void {
  writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      models: {
        providers: {
          "dench-cloud": {},
        },
      },
    }),
  );
  writeFileSync(
    path.join(stateDir, ".dench-integrations.json"),
    JSON.stringify({
      schemaVersion: 1,
      apollo: {},
    }),
  );
}

function createApi() {
  const tools: any[] = [];
  const api = {
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
  } as unknown as Parameters<typeof register>[0];
  return {
    api,
    tools,
  };
}

describe("apollo-enrichment requiredFields", () => {
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

  it("omits requiredFields and mode by default for people enrichment", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "apollo-enrichment-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");
    writeOpenClawConfig(stateDir);

    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://gateway.example.com/v1/enrichment/people");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ email: "jane@acme.com" });
      expect(body.mode).toBeUndefined();
      expect(body.requiredFields).toBeUndefined();
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

  it("forwards camelCase requiredFields to people enrichment when callers provide them", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "apollo-enrichment-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");
    writeOpenClawConfig(stateDir);

    globalThis.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        email: "jane@acme.com",
        requiredFields: ["phone", "headline"],
      });
      expect(body.mode).toBeUndefined();
      return new Response(JSON.stringify({ person: { id: "p1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { api, tools } = createApi();
    register(api);

    await tools[0].execute("call_1", {
      action: "people",
      email: "jane@acme.com",
      requiredFields: ["phone", "headline"],
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts the snake_case required_fields legacy alias", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "apollo-enrichment-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");
    writeOpenClawConfig(stateDir);

    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        email: "jane@acme.com",
        requiredFields: ["phone"],
      });
      return new Response(JSON.stringify({ person: { id: "p1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { api, tools } = createApi();
    register(api);

    await tools[0].execute("call_1", {
      action: "people",
      email: "jane@acme.com",
      required_fields: ["phone"],
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("sends person name inputs with gateway-compatible snake_case keys", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "apollo-enrichment-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");
    writeOpenClawConfig(stateDir);

    globalThis.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        first_name: "Mark",
        last_name: "Rachapoom",
        organization_name: "Dench",
        linkedin_url: "https://www.linkedin.com/in/markrachapoom",
      });
      expect(body.mode).toBeUndefined();
      return new Response(JSON.stringify({ person: { email: "mark@dench.com" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { api, tools } = createApi();
    register(api);

    await tools[0].execute("call_1", {
      action: "people",
      firstName: "Mark",
      lastName: "Rachapoom",
      organizationName: "Dench",
      linkedinUrl: "https://www.linkedin.com/in/markrachapoom",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("sends people search filters with gateway-compatible snake_case keys", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "apollo-enrichment-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");
    writeOpenClawConfig(stateDir);

    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        person_titles: ["Founder"],
        person_locations: ["San Francisco"],
        organization_domains: ["dench.com"],
        per_page: 5,
      });
      return new Response(JSON.stringify({ people: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { api, tools } = createApi();
    register(api);

    await tools[0].execute("call_1", {
      action: "people_search",
      personTitles: ["Founder"],
      personLocations: ["San Francisco"],
      organizationDomains: ["dench.com"],
      perPage: 5,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("forwards CSV requiredFields query param for company enrichment", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "apollo-enrichment-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");
    writeOpenClawConfig(stateDir);

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://gateway.example.com/v1/enrichment/company");
      expect(url.searchParams.get("domain")).toBe("acme.com");
      expect(url.searchParams.get("requiredFields")).toBe("description,headcount,industryList");
      expect(url.searchParams.get("mode")).toBeNull();
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
      requiredFields: ["description", "headcount", "industryList"],
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
