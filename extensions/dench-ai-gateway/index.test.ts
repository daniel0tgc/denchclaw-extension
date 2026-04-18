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

function createApi(params?: { gatewayUrl?: string; withMcp?: boolean }) {
  const gatewayUrl = params?.gatewayUrl ?? "https://gateway.example.com";
  const providers: any[] = [];
  const tools: any[] = [];
  const services: any[] = [];
  const info = vi.fn();

  const api: any = {
    config: {
      ...(params?.withMcp
        ? {
            mcp: {
              servers: {
                composio: {
                  url: `${gatewayUrl}/v1/composio/mcp`,
                  transport: "streamable-http",
                  headers: {
                    Authorization: "Bearer dc-key",
                  },
                },
              },
            },
          }
        : {}),
      plugins: {
        entries: {
          "dench-ai-gateway": {
            config: {
              enabled: true,
              gatewayUrl,
            },
          },
        },
      },
    },
    registerProvider(provider: any) {
      providers.push(provider);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerService(service: any) {
      services.push(service);
    },
    logger: {
      info,
    },
  };

  return { api, providers, tools, services, info };
}

describe("dench-ai-gateway composio bridge", () => {
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

  it("strips the raw composio MCP server and registers the Dench Integrations execute bridge", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      expect(url).toBe("https://gateway.example.com/v1/composio/tools/execute");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        accept: "application/json",
        authorization: "Bearer dc-key",
      });
      expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
        tool_slug: "GMAIL_FETCH_EMAILS",
        arguments: {
          label_ids: ["INBOX"],
          max_results: 10,
        },
      });

      return new Response(
        JSON.stringify({
          data: {
            messages: [{ id: "m1", subject: "Hello" }],
          },
          error: null,
          log_id: "log_gmail_1",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const { api, providers, tools, services, info } = createApi({ withMcp: true });
    register(api);

    expect(providers).toHaveLength(1);
    expect(services).toHaveLength(1);
    expect(tools.map((tool) => tool.name)).toEqual(["dench_execute_integrations"]);
    expect(api.config.mcp).toBeUndefined();
    expect(info).toHaveBeenCalledWith(
      "[dench-ai-gateway] registered dench_execute_integrations bridge tool",
    );

    const result = await tools[0].execute("call-1", {
      tool_slug: "GMAIL_FETCH_EMAILS",
      arguments: {
        label_ids: ["INBOX"],
        max_results: 10,
      },
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      denchIntegrations: true,
      tool_slug: "GMAIL_FETCH_EMAILS",
      logId: "log_gmail_1",
      structuredContent: {
        messages: [{ id: "m1", subject: "Hello" }],
      },
    });
    expect(result.content[0]?.text).toContain('"subject": "Hello"');
  });

  it("registers a stable generic schema for dench_execute_integrations", () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");

    const { api, tools } = createApi();
    register(api);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("dench_execute_integrations");
    expect(tools[0].parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["tool_slug"],
      properties: {
        tool_slug: {
          type: "string",
        },
        arguments: {
          type: "object",
          additionalProperties: true,
        },
        connected_account_id: {
          type: "string",
        },
      },
    });
  });

  it("passes connected_account_id through to gateway execution when provided", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      expect(url).toBe("https://gateway.example.com/v1/composio/tools/execute");
      expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
        tool_slug: "STRIPE_LIST_SUBSCRIPTIONS",
        arguments: {
          limit: 100,
        },
        connected_account_id: "acct_primary",
      });

      return new Response(
        JSON.stringify({
          data: {
            data: [{ id: "sub_123" }],
          },
          error: null,
          log_id: "log_stripe_1",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const { api, tools } = createApi();
    register(api);

    const result = await tools[0].execute("call-1", {
      tool_slug: "STRIPE_LIST_SUBSCRIPTIONS",
      connected_account_id: "acct_primary",
      arguments: {
        limit: 100,
      },
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      denchIntegrations: true,
      tool_slug: "STRIPE_LIST_SUBSCRIPTIONS",
      connectedAccountId: "acct_primary",
      logId: "log_stripe_1",
    });
    expect(result.content[0]?.text).toContain('"sub_123"');
  });

  it("surfaces account selection required responses from the gateway", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "composio_account_selection_required",
              message: "Stripe requires an explicit account selection.",
            },
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    ) as typeof fetch;

    const { api, tools } = createApi();
    register(api);

    const result = await tools[0].execute("call-1", {
      tool_slug: "STRIPE_LIST_SUBSCRIPTIONS",
      arguments: {},
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      status: "error",
      errorCode: "composio_account_selection_required",
      tool_slug: "STRIPE_LIST_SUBSCRIPTIONS",
    });
    expect(result.content[0]?.text).toContain("requires an explicit account selection");
    expect(result.content[0]?.text).toContain("connected_account_id");
  });

  it("surfaces not-connected responses from the gateway", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "composio_not_connected",
              message: "Slack is not connected.",
            },
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    ) as typeof fetch;

    const { api, tools } = createApi();
    register(api);

    const result = await tools[0].execute("call-1", {
      tool_slug: "SLACK_LIST_CHANNELS",
      arguments: {},
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      status: "error",
      errorCode: "composio_not_connected",
      tool_slug: "SLACK_LIST_CHANNELS",
    });
    expect(result.content[0]?.text).toContain("Slack is not connected.");
    expect(result.content[0]?.text).toContain('"not_connected": true');
  });

  it("requires tool_slug and skips gateway execution when it is missing", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");

    globalThis.fetch = vi.fn() as typeof fetch;

    const { api, tools } = createApi();
    register(api);

    const result = await tools[0].execute("call-1", {
      arguments: {},
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain("The `tool_slug` field is required");
    expect(result.content[0]?.text).toContain("dench_search_integrations");
  });
});
