import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createComposioSearchContextSecret,
  signComposioSearchContext,
} from "../shared/composio-search-context.js";
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

function buildSearchContextToken(params: {
  workspaceDir: string;
  gatewayUrl: string;
  apiKey: string;
  app: string;
  toolName: string;
  mode: "gateway_tool_router" | "local_catalog_mcp";
  sessionId?: string;
}) {
  return signComposioSearchContext({
    version: 1,
    mode: params.mode,
    app: params.app,
    tool_name: params.toolName,
    ...(params.sessionId ? { session_id: params.sessionId } : {}),
    issued_at: "2026-04-06T00:00:00.000Z",
  }, createComposioSearchContextSecret({
    workspaceDir: params.workspaceDir,
    gatewayUrl: params.gatewayUrl,
    apiKey: params.apiKey,
  }));
}

describe("dench-ai-gateway composio bridge", () => {
  const originalFetch = globalThis.fetch;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let workspaceDir: string | undefined;
  let stateDir: string | undefined;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
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

  it("strips the raw composio MCP server and registers the generic Composio dispatcher", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");

    workspaceDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-"));
    writeFileSync(
      path.join(workspaceDir, "composio-tool-index.json"),
      JSON.stringify(
        {
          generated_at: "2026-04-02T00:00:00.000Z",
          managed_tools: ["composio_search_tools", "composio_resolve_tool", "composio_call_tool"],
          connected_apps: [
            {
              toolkit_slug: "gmail",
              toolkit_name: "Gmail",
              account_count: 1,
              accounts: [
                {
                  connected_account_id: "conn_gmail_1",
                  account_identity: "user@gmail.com",
                  account_identity_source: "gateway_stable_id",
                  identity_confidence: "high",
                  display_label: "user@gmail.com",
                  related_connection_ids: [],
                  is_same_account_reconnect: false,
                },
              ],
              tools: [
                {
                  name: "GMAIL_FETCH_EMAILS",
                  title: "Fetch emails",
                  description_short: "Fetch recent Gmail messages.",
                  required_args: [],
                  arg_hints: {
                    label_ids: 'Must be an array like ["INBOX"].',
                  },
                  default_args: { label_ids: ["INBOX"], max_results: 10 },
                  input_schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      label_ids: {
                        type: "array",
                        items: { type: "string" },
                      },
                      max_results: {
                        type: "number",
                      },
                    },
                  },
                },
                {
                  name: "GMAIL_SEND_EMAIL",
                  title: "Send email",
                  description_short: "Send a Gmail message.",
                  required_args: ["to", "subject", "body"],
                  arg_hints: {},
                  input_schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      to: { type: "string" },
                      subject: { type: "string" },
                      body: { type: "string" },
                    },
                    required: ["to", "subject", "body"],
                  },
                },
              ],
              recipes: {
                "Read recent emails": "GMAIL_FETCH_EMAILS",
                "Send email": "GMAIL_SEND_EMAIL",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const providers: any[] = [];
    const tools: any[] = [];
    const services: any[] = [];
    const info = vi.fn();

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const payload = JSON.parse(String(init?.body ?? "{}"));
      expect(url).toBe("https://gateway.example.com/v1/composio/tool-router/execute");
      expect(payload).toEqual({
        session_id: "trs_gmail_1",
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

    const api: any = {
      config: {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        models: {
          providers: {
            "dench-cloud": {
              apiKey: "dc-key",
            },
          },
        },
        mcp: {
          servers: {
            composio: {
              url: "https://gateway.example.com/v1/composio/mcp",
              transport: "streamable-http",
              headers: {
                Authorization: "Bearer dc-key",
              },
            },
          },
        },
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

    register(api);

    expect(providers).toHaveLength(1);
    expect(services).toHaveLength(1);
    expect(tools.map((tool) => tool.name)).toEqual(["composio_call_tool"]);
    expect(api.config.mcp).toBeUndefined();

    const searchContextToken = buildSearchContextToken({
      workspaceDir,
      gatewayUrl: "https://gateway.example.com",
      apiKey: "dc-key",
      app: "gmail",
      toolName: "GMAIL_FETCH_EMAILS",
      mode: "gateway_tool_router",
      sessionId: "trs_gmail_1",
    });
    const result = await tools[0].execute("call-1", {
      app: "gmail",
      tool_name: "GMAIL_FETCH_EMAILS",
      search_context_token: searchContextToken,
      search_session_id: "trs_gmail_1",
      arguments: {
        label_ids: ["INBOX"],
        max_results: 10,
      },
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      composioBridge: true,
      composioMode: "gateway_tool_router",
      toolRouterSessionId: "trs_gmail_1",
      mcpTool: "GMAIL_FETCH_EMAILS",
      toolkit: "gmail",
    });
    expect(result.content[0]?.text).toContain('"subject": "Hello"');
  });

  it("registers a stable generic schema for composio_call_tool", () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");

    workspaceDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-"));
    writeFileSync(
      path.join(workspaceDir, "composio-tool-index.json"),
      JSON.stringify(
        {
          generated_at: "2026-04-02T00:00:00.000Z",
          managed_tools: ["composio_search_tools", "composio_resolve_tool", "composio_call_tool"],
          connected_apps: [
            {
              toolkit_slug: "gmail",
              toolkit_name: "Gmail",
              account_count: 1,
              accounts: [
                {
                  connected_account_id: "conn_gmail_1",
                  account_identity: "user@gmail.com",
                  account_identity_source: "gateway_stable_id",
                  identity_confidence: "high",
                  display_label: "user@gmail.com",
                  related_connection_ids: [],
                  is_same_account_reconnect: false,
                },
              ],
              tools: [
                {
                  name: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
                  title: "Fetch message",
                  description_short: "Fetch one Gmail message.",
                  required_args: ["message_id"],
                  arg_hints: {
                    message_id: "Use the Gmail message id.",
                  },
                },
              ],
              recipes: {
                "Read one email": "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const tools: any[] = [];
    const api: any = {
      config: {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        models: {
          providers: {
            "dench-cloud": {
              apiKey: "dc-key",
            },
          },
        },
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
      registerProvider() {},
      registerTool(tool: any) {
        tools.push(tool);
      },
      registerService() {},
      logger: {
        info: vi.fn(),
      },
    };

    register(api);

    expect(tools).toHaveLength(1);
    expect(tools[0].parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["app", "tool_name", "search_context_token"],
      properties: {
        app: {
          type: "string",
        },
        tool_name: {
          type: "string",
        },
        search_context_token: {
          type: "string",
        },
        arguments: {
          type: "object",
          additionalProperties: true,
        },
      },
    });
  });

  it("executes gateway-backed Composio search results through the tool-router endpoint", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");

    workspaceDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-"));
    writeFileSync(
      path.join(workspaceDir, "composio-tool-index.json"),
      JSON.stringify(
        {
          generated_at: "2026-04-02T00:00:00.000Z",
          managed_tools: ["composio_search_tools", "composio_resolve_tool", "composio_call_tool"],
          connected_apps: [
            {
              toolkit_slug: "stripe",
              toolkit_name: "Stripe",
              account_count: 1,
              tools: [
                {
                  name: "STRIPE_LIST_SUBSCRIPTIONS",
                  title: "List subscriptions",
                  description_short: "List subscriptions.",
                  required_args: [],
                  arg_hints: {},
                },
              ],
              recipes: {
                "List subscriptions": "STRIPE_LIST_SUBSCRIPTIONS",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const tools: any[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      expect(url).toBe("https://gateway.example.com/v1/composio/tool-router/execute");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({
        session_id: "trs_123",
        tool_slug: "STRIPE_LIST_SUBSCRIPTIONS",
        arguments: {
          limit: 100,
          starting_after: "sub_prev",
        },
        account: "acct_primary",
      });

      return new Response(
        JSON.stringify({
          data: {
            has_more: true,
            next_cursor: "sub_next",
            data: [{ id: "sub_123" }],
          },
          error: null,
          log_id: "log_123",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as typeof fetch;

    const api: any = {
      config: {
        agents: { defaults: { workspace: workspaceDir } },
        plugins: {
          entries: {
            "dench-ai-gateway": {
              config: { enabled: true, gatewayUrl: "https://gateway.example.com" },
            },
          },
        },
      },
      registerProvider() {},
      registerTool(tool: any) {
        tools.push(tool);
      },
      registerService() {},
      logger: { info: vi.fn() },
    };

    register(api);

    const searchContextToken = buildSearchContextToken({
      workspaceDir,
      gatewayUrl: "https://gateway.example.com",
      apiKey: "dc-key",
      app: "stripe",
      toolName: "STRIPE_LIST_SUBSCRIPTIONS",
      mode: "gateway_tool_router",
      sessionId: "trs_123",
    });
    const result = await tools[0].execute("call-1", {
      app: "stripe",
      tool_name: "STRIPE_LIST_SUBSCRIPTIONS",
      search_context_token: searchContextToken,
      search_session_id: "trs_123",
      account: "acct_primary",
      arguments: {
        limit: 100,
        starting_after: "sub_prev",
      },
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      composioBridge: true,
      composioMode: "gateway_tool_router",
      toolRouterSessionId: "trs_123",
      mcpTool: "STRIPE_LIST_SUBSCRIPTIONS",
      toolkit: "stripe",
      account: "acct_primary",
      pagination: {
        has_more: true,
        next_cursor: "sub_next",
      },
    });
    expect(result.content[0]?.text).toContain('"sub_123"');
  });

  it("rejects legacy local-catalog search context and asks for a fresh gateway search", async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeAuthProfiles(stateDir, "dc-key");

    workspaceDir = mkdtempSync(path.join(os.tmpdir(), "dench-ai-gateway-"));
    writeFileSync(
      path.join(workspaceDir, "composio-tool-index.json"),
      JSON.stringify(
        {
          generated_at: "2026-04-02T00:00:00.000Z",
          managed_tools: ["composio_search_tools", "composio_resolve_tool", "composio_call_tool"],
          connected_apps: [
            {
              toolkit_slug: "stripe",
              toolkit_name: "Stripe",
              account_count: 2,
              accounts: [
                {
                  connected_account_id: "conn_stripe_1",
                  account_identity: "stripe:acct_prod",
                  account_identity_source: "gateway_stable_id",
                  identity_confidence: "high",
                  display_label: "Prod Stripe",
                  account_email: "ops@example.com",
                  related_connection_ids: [],
                  is_same_account_reconnect: false,
                },
                {
                  connected_account_id: "conn_stripe_2",
                  account_identity: "stripe:acct_test",
                  account_identity_source: "gateway_stable_id",
                  identity_confidence: "high",
                  display_label: "Test Stripe",
                  account_email: "dev@example.com",
                  related_connection_ids: [],
                  is_same_account_reconnect: false,
                },
              ],
              tools: [],
              recipes: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const tools: any[] = [];
    const api: any = {
      config: {
        agents: { defaults: { workspace: workspaceDir } },
        plugins: {
          entries: {
            "dench-ai-gateway": {
              config: { enabled: true, gatewayUrl: "https://gateway.example.com" },
            },
          },
        },
      },
      registerProvider() {},
      registerTool(tool: any) {
        tools.push(tool);
      },
      registerService() {},
      logger: { info: vi.fn() },
    };

    register(api);

    const searchContextToken = buildSearchContextToken({
      workspaceDir,
      gatewayUrl: "https://gateway.example.com",
      apiKey: "dc-key",
      app: "stripe",
      toolName: "STRIPE_LIST_SUBSCRIPTIONS",
      mode: "local_catalog_mcp",
    });
    const result = await tools[0].execute("call-1", {
      app: "stripe",
      tool_name: "STRIPE_LIST_SUBSCRIPTIONS",
      search_context_token: searchContextToken,
      arguments: {},
    });
    expect(result.content[0]?.text).toContain("requires gateway-backed integration execution metadata");
  });
});
