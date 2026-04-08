import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { readDenchAuthProfileKey } from "../shared/dench-auth.js";
import {
  createComposioSearchContextSecret,
  verifyComposioSearchContext,
} from "../shared/composio-search-context.js";
import { buildComposioMcpServerConfig } from "./config-patch.js";

type UnknownRecord = Record<string, unknown>;

type ComposioManagedAccount = {
  connected_account_id: string;
  account_identity: string;
  account_identity_source: "gateway_stable_id" | "legacy_heuristic" | "connection_id";
  identity_confidence: "high" | "low" | "unknown";
  display_label: string;
  account_label?: string | null;
  account_name?: string | null;
  account_email?: string | null;
  external_account_id?: string | null;
  related_connection_ids: string[];
  is_same_account_reconnect: boolean;
};

type ComposioToolSummary = {
  name: string;
  title: string;
  description_short: string;
  required_args: string[];
  arg_hints: Record<string, string>;
  default_args?: Record<string, unknown>;
  example_args?: Record<string, unknown>;
  example_prompts?: string[];
  input_schema?: Record<string, unknown>;
};

type ComposioToolIndexFile = {
  generated_at: string;
  managed_tools?: string[];
  connected_apps: Array<{
    toolkit_slug: string;
    toolkit_name: string;
    account_count: number;
    accounts?: ComposioManagedAccount[];
    tools: ComposioToolSummary[];
    recipes: Record<string, string>;
  }>;
};

type ComposioToolCallResult = {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
};

const COMPOSIO_CALL_TOOL_NAME = "composio_call_tool";
const DENCH_INTEGRATIONS_DISPLAY_NAME = "Dench Integrations";
const DENCH_INTEGRATION_DISPLAY_NAME = "Dench Integration";

const COMPOSIO_CALL_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    app: {
      type: "string",
      description: "Connected toolkit slug, for example gmail, slack, github, stripe, or google-calendar.",
    },
    tool_name: {
      type: "string",
      description: "Exact integration tool name returned by composio_search_tools or composio_resolve_tool.",
    },
    search_context_token: {
      type: "string",
      description: "Opaque token returned by composio_search_tools or composio_resolve_tool. Required to enforce search-before-call.",
    },
    search_session_id: {
      type: "string",
      description: "Optional integration search session id returned by composio_search_tools. Required for gateway-backed official execution results.",
    },
    account: {
      type: "string",
      description: "Optional account id or alias returned by composio_search_tools for official gateway tool-router execution.",
    },
    connected_account_id: {
      type: "string",
      description: "Legacy fallback for local catalog execution when multiple accounts exist.",
    },
    account_identity: {
      type: "string",
      description: "Legacy fallback for local catalog execution when multiple accounts exist.",
    },
    arguments: {
      type: "object",
      additionalProperties: true,
      description: "JSON arguments object for the underlying integration tool call.",
      properties: {},
    },
  },
  required: ["app", "tool_name", "search_context_token"],
} as const;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function jsonResult(payload: unknown, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: details ?? payload,
  };
}

function isComposioToolIndexFile(value: unknown): value is ComposioToolIndexFile {
  const rec = asRecord(value);
  return typeof rec?.generated_at === "string" && Array.isArray(rec.connected_apps);
}

function readComposioToolIndex(workspaceDir: string): ComposioToolIndexFile | null {
  const filePath = path.join(workspaceDir, "composio-tool-index.json");
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return isComposioToolIndexFile(raw) ? raw : null;
  } catch {
    return null;
  }
}

function normalizeToolkitSlug(value: string): string {
  return value.trim().toLowerCase();
}

function toolkitSlugToToolPrefix(slug: string): string {
  return normalizeToolkitSlug(slug).toUpperCase().replace(/-/g, "_") + "_";
}

function resolveAppEntry(
  index: ComposioToolIndexFile,
  requestedApp: string,
  toolName: string,
): ComposioToolIndexFile["connected_apps"][number] | null {
  const normalized = normalizeToolkitSlug(requestedApp);
  const direct = index.connected_apps.find((app) =>
    normalizeToolkitSlug(app.toolkit_slug) === normalized
      || normalizeToolkitSlug(app.toolkit_name) === normalized
  );
  if (direct) {
    return direct;
  }

  const matchingPrefix = index.connected_apps.find((app) =>
    toolName.toUpperCase().startsWith(toolkitSlugToToolPrefix(app.toolkit_slug))
  );
  return matchingPrefix ?? null;
}

function resolveAccountSelection(
  app: ComposioToolIndexFile["connected_apps"][number],
  connectedAccountId: string | undefined,
  accountIdentity: string | undefined,
): ComposioManagedAccount | null {
  const accounts = app.accounts ?? [];
  if (accounts.length === 0) {
    return null;
  }

  if (connectedAccountId) {
    const exact = accounts.find((account) => account.connected_account_id === connectedAccountId);
    if (exact) {
      return exact;
    }
  }

  if (accountIdentity) {
    const normalized = accountIdentity.toLowerCase();
    const exact = accounts.find((account) => account.account_identity.toLowerCase() === normalized);
    if (exact) {
      return exact;
    }
  }

  if (accounts.length === 1) {
    return accounts[0] ?? null;
  }

  return null;
}

function buildToolCallUrl(baseUrl: string, connectedAccountId?: string): string {
  if (!connectedAccountId) {
    return baseUrl;
  }
  const url = new URL(baseUrl);
  url.searchParams.set("connected_account_id", connectedAccountId);
  return url.toString();
}

function resolveWorkspaceDir(api: any): string | undefined {
  const ws = api?.config?.agents?.defaults?.workspace;
  return typeof ws === "string" ? ws.trim() || undefined : undefined;
}

function resolveAuthorizationHeader(headers: unknown): string | undefined {
  const rec = asRecord(headers);
  return readString(rec?.Authorization) ?? readString(rec?.authorization);
}

function stripRuntimeComposioServer(api: any): { url?: string; authorization?: string } | null {
  const rootConfig = asRecord(api?.config);
  const mcp = asRecord(rootConfig?.mcp);
  const servers = asRecord(mcp?.servers);
  if (!rootConfig || !mcp || !servers) {
    return null;
  }
  const composio = asRecord(servers?.composio);
  if (!composio) {
    return null;
  }

  const captured = {
    url: readString(composio.url),
    authorization: resolveAuthorizationHeader(composio.headers),
  };

  delete servers.composio;
  if (Object.keys(servers).length === 0) {
    delete mcp.servers;
  }
  if (mcp && Object.keys(mcp).length === 0) {
    delete rootConfig.mcp;
  }

  return captured;
}

function resolveConfiguredApiKey(_api: any): string | undefined {
  return readDenchAuthProfileKey();
}

function resolveComposioServerConfig(api: any, fallbackGatewayUrl: string) {
  const stripped = stripRuntimeComposioServer(api);
  const apiKey = resolveConfiguredApiKey(api);
  if (stripped?.url) {
    return {
      url: stripped.url,
      authorization: stripped.authorization ?? (apiKey ? `Bearer ${apiKey}` : undefined),
    };
  }

  if (!apiKey) {
    return null;
  }

  const config = buildComposioMcpServerConfig(fallbackGatewayUrl, apiKey);
  return {
    url: config.url,
    authorization: config.headers.Authorization,
  };
}

function resolveGatewayBaseUrl(mcpUrl: string, fallbackGatewayUrl: string): string {
  const trimmedMcpUrl = mcpUrl.trim().replace(/\/$/, "");
  const fromMcp = trimmedMcpUrl.replace(/\/v1\/composio\/mcp(?:\?.*)?$/u, "");
  if (fromMcp && fromMcp !== trimmedMcpUrl) {
    return fromMcp;
  }
  return fallbackGatewayUrl.trim().replace(/\/$/, "");
}

function extractPaginationState(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const keys = [
    "has_more",
    "next_cursor",
    "next_page",
    "starting_after",
    "ending_before",
    "page",
    "page_info",
  ];
  const pagination = Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(record, key))
      .map((key) => [key, record[key]]),
  );
  return Object.keys(pagination).length > 0 ? pagination : undefined;
}

function classifyComposioExecutionFailure(value: unknown): string | undefined {
  const text = readString(value)?.toLowerCase();
  if (!text) {
    return undefined;
  }
  if (text.includes("session")) {
    return "session_issue";
  }
  if (text.includes("account") || text.includes("multi-account")) {
    return "account_issue";
  }
  if (text.includes("connect") || text.includes("no active connection")) {
    return "connection_issue";
  }
  if (
    text.includes("argument")
    || text.includes("input")
    || text.includes("schema")
    || text.includes("required")
    || text.includes("invalid")
  ) {
    return "schema_issue";
  }
  return "execution_issue";
}

function readGatewayConnectionRecords(payload: unknown): UnknownRecord[] {
  const direct = Array.isArray(payload)
    ? payload.filter((item): item is UnknownRecord => Boolean(asRecord(item)))
    : [];
  if (direct.length > 0) {
    return direct;
  }
  const record = asRecord(payload);
  const items = Array.isArray(record?.items)
    ? record.items.filter((item): item is UnknownRecord => Boolean(asRecord(item)))
    : [];
  if (items.length > 0) {
    return items;
  }
  return Array.isArray(record?.connections)
    ? record.connections.filter((item): item is UnknownRecord => Boolean(asRecord(item)))
    : [];
}

function readGatewayConnectionToolkitSlug(connection: UnknownRecord): string | undefined {
  return readString(connection.toolkit_slug ?? asRecord(connection.toolkit)?.slug)?.trim().toLowerCase();
}

function readGatewayConnectionStableIdentity(connection: UnknownRecord): string | undefined {
  const account = asRecord(connection.account);
  return readString(
    connection.account_stable_id
      ?? account?.stableId
      ?? connection.account_email
      ?? account?.email
      ?? connection.account_name
      ?? connection.account_label
      ?? connection.id,
  )?.trim();
}

function matchesGatewayConnectionSelection(connection: UnknownRecord, requestedAccount: string): boolean {
  const normalized = requestedAccount.trim().toLowerCase();
  return [
    readString(connection.connectionId),
    readString(connection.id),
    readString(connection.account_stable_id),
    readString(connection.account_label),
    readString(connection.account_name),
    readString(connection.account_email),
    readString(asRecord(connection.account)?.stableId),
    readString(asRecord(connection.account)?.label),
    readString(asRecord(connection.account)?.email),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .some((value) => value.trim().toLowerCase() === normalized);
}

async function fetchGatewayActiveConnectionsForToolkit(params: {
  gatewayBaseUrl: string;
  authorization?: string;
  app: string;
}): Promise<UnknownRecord[] | null> {
  try {
    const response = await fetch(`${params.gatewayBaseUrl}/v1/composio/connections`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(params.authorization ? { authorization: params.authorization } : {}),
      },
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as unknown;
    const toolkit = normalizeToolkitSlug(params.app);
    return readGatewayConnectionRecords(payload).filter((connection) =>
      readGatewayConnectionToolkitSlug(connection) === toolkit
      && readString(connection.status)?.trim().toUpperCase() === "ACTIVE"
    );
  } catch {
    return null;
  }
}

function resolveGatewayMcpFallbackSelection(params: {
  activeConnections: UnknownRecord[];
  requestedAccount?: string;
}): {
  canFallback: boolean;
  activeConnectionCount: number;
  connectedAccountId?: string;
  accountIdentity?: string;
} {
  const { activeConnections } = params;
  if (activeConnections.length === 0) {
    return {
      canFallback: false,
      activeConnectionCount: 0,
    };
  }
  if (params.requestedAccount?.trim()) {
    const match = activeConnections.find((connection) =>
      matchesGatewayConnectionSelection(connection, params.requestedAccount ?? ""),
    );
    if (!match) {
      return {
        canFallback: false,
        activeConnectionCount: activeConnections.length,
      };
    }
    return {
      canFallback: true,
      activeConnectionCount: activeConnections.length,
      connectedAccountId: readString(match.connectionId ?? match.id)?.trim(),
      accountIdentity: readGatewayConnectionStableIdentity(match),
    };
  }
  if (activeConnections.length !== 1) {
    return {
      canFallback: false,
      activeConnectionCount: activeConnections.length,
    };
  }
  const [connection] = activeConnections;
  return {
    canFallback: true,
    activeConnectionCount: 1,
    connectedAccountId: readString(connection?.connectionId ?? connection?.id)?.trim(),
    accountIdentity: connection ? readGatewayConnectionStableIdentity(connection) : undefined,
  };
}

function extractToolCallResultFromJsonRpcMessage(payload: unknown): ComposioToolCallResult | null {
  const rec = asRecord(payload);
  const result = asRecord(rec?.result);
  if (!result) {
    return null;
  }

  const content = Array.isArray(result.content) ? result.content : undefined;
  const structuredContent = result.structuredContent;
  const hasStructuredContent = Object.hasOwn(result, "structuredContent");
  const isError = result.isError === true;

  if (!content && !hasStructuredContent && !Object.hasOwn(result, "isError")) {
    return null;
  }

  return {
    ...(content ? { content } : {}),
    ...(hasStructuredContent ? { structuredContent } : {}),
    ...(Object.hasOwn(result, "isError") ? { isError } : {}),
  };
}

function parseSseJsonRpcToolCall(body: string): ComposioToolCallResult | null {
  const lines = body.split(/\r?\n/);
  let lastPayload: unknown = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") {
      continue;
    }
    try {
      lastPayload = JSON.parse(raw);
    } catch {
      // Ignore non-JSON SSE frames.
    }
  }

  return lastPayload === null ? null : extractToolCallResultFromJsonRpcMessage(lastPayload);
}

async function parseToolCallResponse(res: Response): Promise<ComposioToolCallResult | null> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    const fromSse = parseSseJsonRpcToolCall(text);
    if (fromSse) {
      return fromSse;
    }
  }

  try {
    return extractToolCallResultFromJsonRpcMessage(JSON.parse(text) as unknown);
  } catch {
    return parseSseJsonRpcToolCall(text);
  }
}

function toAgentToolResult(toolName: string, result: ComposioToolCallResult) {
  const content =
    Array.isArray(result.content) && result.content.length > 0
      ? result.content
      : result.structuredContent !== undefined
        ? [{ type: "text" as const, text: JSON.stringify(result.structuredContent, null, 2) }]
        : [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: result.isError === true ? "error" : "ok",
                  server: "composio",
                  tool: toolName,
                },
                null,
                2,
              ),
            },
          ];

  const details: Record<string, unknown> = {
    composioBridge: true,
    mcpServer: "composio",
    mcpTool: toolName,
  };
  if (result.structuredContent !== undefined) {
    details.structuredContent = result.structuredContent;
  }
  if (result.isError === true) {
    details.status = "error";
  }

  return {
    content: content as Array<{ type: string; text?: string }>,
    details,
  };
}

async function executeComposioTool(params: {
  url: string;
  authorization?: string;
  toolName: string;
  input: Record<string, unknown>;
  connectedAccountId?: string;
  app?: string;
  accountIdentity?: string;
}) {
  try {
    const res = await fetch(buildToolCallUrl(params.url, params.connectedAccountId), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(params.authorization ? { authorization: params.authorization } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: params.toolName,
          arguments: params.input,
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return jsonResult(
        {
          error: `${DENCH_INTEGRATION_DISPLAY_NAME} tool ${params.toolName} failed (HTTP ${res.status}).`,
          detail: detail || undefined,
        },
        {
          composioBridge: true,
          mcpServer: "composio",
          mcpTool: params.toolName,
          ...(params.app ? { toolkit: params.app } : {}),
          ...(params.connectedAccountId ? { connectedAccountId: params.connectedAccountId } : {}),
          ...(params.accountIdentity ? { accountIdentity: params.accountIdentity } : {}),
          status: "error",
        },
      );
    }

    const parsed = await parseToolCallResponse(res);
    if (!parsed) {
      return jsonResult(
        {
          error: `${DENCH_INTEGRATION_DISPLAY_NAME} tool ${params.toolName} returned an unreadable response.`,
        },
        {
          composioBridge: true,
          mcpServer: "composio",
          mcpTool: params.toolName,
          ...(params.app ? { toolkit: params.app } : {}),
          ...(params.connectedAccountId ? { connectedAccountId: params.connectedAccountId } : {}),
          ...(params.accountIdentity ? { accountIdentity: params.accountIdentity } : {}),
          status: "error",
        },
      );
    }

    const result = toAgentToolResult(params.toolName, parsed);
    return {
      ...result,
      details: {
        ...result.details,
        ...(params.app ? { toolkit: params.app } : {}),
        ...(params.connectedAccountId ? { connectedAccountId: params.connectedAccountId } : {}),
        ...(params.accountIdentity ? { accountIdentity: params.accountIdentity } : {}),
      },
    };
  } catch (error) {
    return jsonResult(
      {
        error: `${DENCH_INTEGRATION_DISPLAY_NAME} tool ${params.toolName} failed.`,
        detail: error instanceof Error ? error.message : String(error),
      },
      {
        composioBridge: true,
        mcpServer: "composio",
        mcpTool: params.toolName,
        ...(params.app ? { toolkit: params.app } : {}),
        ...(params.connectedAccountId ? { connectedAccountId: params.connectedAccountId } : {}),
        ...(params.accountIdentity ? { accountIdentity: params.accountIdentity } : {}),
        status: "error",
      },
    );
  }
}

async function executeComposioToolRouter(params: {
  gatewayBaseUrl: string;
  authorization?: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  account?: string;
  app?: string;
}) {
  try {
    const res = await fetch(`${params.gatewayBaseUrl}/v1/composio/tool-router/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(params.authorization ? { authorization: params.authorization } : {}),
      },
      body: JSON.stringify({
        session_id: params.sessionId,
        tool_slug: params.toolName,
        arguments: params.input,
        ...(params.account ? { account: params.account } : {}),
      }),
    });

    const text = await res.text();
    let parsed: UnknownRecord | undefined;
    try {
      parsed = JSON.parse(text) as UnknownRecord;
    } catch {
      parsed = undefined;
    }
    const upstreamError = readString(parsed?.error) ?? (text || undefined);
    const failureKind = classifyComposioExecutionFailure(upstreamError);

    if (!res.ok) {
      return jsonResult(
        {
          error: `${DENCH_INTEGRATION_DISPLAY_NAME} tool ${params.toolName} failed (HTTP ${res.status}).`,
          detail: parsed ?? (text || undefined),
          ...(failureKind ? { failure_kind: failureKind } : {}),
        },
        {
          composioBridge: true,
          composioMode: "gateway_tool_router",
          toolRouterSessionId: params.sessionId,
          mcpTool: params.toolName,
          ...(params.app ? { toolkit: params.app } : {}),
          ...(params.account ? { account: params.account } : {}),
          status: "error",
          ...(failureKind ? { failureKind } : {}),
        },
      );
    }

    const data = parsed?.data;
    const error = readString(parsed?.error);
    const pagination = extractPaginationState(data);
    const contentPayload = error ? { error, data } : (data ?? parsed ?? {});
    const structuredFailureKind = classifyComposioExecutionFailure(error);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(contentPayload, null, 2),
      }],
      details: {
        composioBridge: true,
        composioMode: "gateway_tool_router",
        toolRouterSessionId: params.sessionId,
        mcpTool: params.toolName,
        ...(params.app ? { toolkit: params.app } : {}),
        ...(params.account ? { account: params.account } : {}),
        ...(parsed?.log_id ? { logId: parsed.log_id } : {}),
        ...(data !== undefined ? { structuredContent: data } : {}),
        ...(pagination ? { pagination } : {}),
        ...(error ? { status: "error", error } : {}),
        ...(structuredFailureKind ? { failureKind: structuredFailureKind } : {}),
      },
    };
  } catch (error) {
    const failureKind = classifyComposioExecutionFailure(
      error instanceof Error ? error.message : String(error),
    );
    return jsonResult(
      {
        error: `${DENCH_INTEGRATION_DISPLAY_NAME} tool ${params.toolName} failed.`,
        detail: error instanceof Error ? error.message : String(error),
        ...(failureKind ? { failure_kind: failureKind } : {}),
      },
      {
        composioBridge: true,
        composioMode: "gateway_tool_router",
        toolRouterSessionId: params.sessionId,
        mcpTool: params.toolName,
        ...(params.app ? { toolkit: params.app } : {}),
        ...(params.account ? { account: params.account } : {}),
        status: "error",
        ...(failureKind ? { failureKind } : {}),
      },
    );
  }
}

function createRegisteredComposioTools(params: {
  serverConfig: {
    url: string;
    authorization?: string;
    gatewayBaseUrl: string;
  };
  searchContextSecret: string;
}): AnyAgentTool[] {
  return [
    {
      name: COMPOSIO_CALL_TOOL_NAME,
      label: `${DENCH_INTEGRATIONS_DISPLAY_NAME} Call`,
      description:
        `Execute an exact ${DENCH_INTEGRATION_DISPLAY_NAME.toLowerCase()} tool returned by composio_search_tools or composio_resolve_tool through the gateway-backed integration session.`,
      parameters: COMPOSIO_CALL_TOOL_PARAMETERS,
      execute: async (_toolCallId: string, input: Record<string, unknown>) => {
        const payload = asRecord(input) ?? {};
        const requestedApp = readString(payload.app)?.trim();
        const toolName = readString(payload.tool_name)?.trim();
        const searchContextToken = readString(payload.search_context_token)?.trim();
        const searchSessionId = readString(payload.search_session_id)?.trim();
        const requestedAccount = readString(payload.account)?.trim();
        const connectedAccountId = readString(payload.connected_account_id)?.trim();
        const accountIdentity = readString(payload.account_identity)?.trim();
        const toolArgs = asRecord(payload.arguments) ?? {};

        if (!requestedApp || !toolName || !searchContextToken) {
          return jsonResult({
            error: "The `app`, `tool_name`, and `search_context_token` fields are required for composio_call_tool.",
          });
        }

        const searchContext = verifyComposioSearchContext(
          searchContextToken,
          params.searchContextSecret,
        );
        if (!searchContext) {
          return jsonResult({
            error: "This integration tool call is missing valid search context. Call composio_search_tools first and use the returned dispatcher_input.",
          });
        }

        if (
          normalizeToolkitSlug(searchContext.app) !== normalizeToolkitSlug(requestedApp)
          || searchContext.tool_name !== toolName
        ) {
          return jsonResult({
            error: "The requested integration tool does not match the verified search result. Re-run composio_search_tools and use the returned dispatcher_input unchanged.",
          });
        }

        const expectedPrefix = toolkitSlugToToolPrefix(searchContext.app);
        if (!toolName.toUpperCase().startsWith(expectedPrefix)) {
          return jsonResult({
            error: `Tool ${toolName} does not match the verified ${searchContext.app} app.`,
            expected_prefix: expectedPrefix,
          });
        }

        if (searchContext.mode !== "gateway_tool_router") {
          return jsonResult({
            error: "This workspace now requires gateway-backed integration execution metadata. Re-run composio_search_tools and use the returned dispatcher_input from the live gateway result.",
          });
        }

        if (!requestedApp || normalizeToolkitSlug(requestedApp) !== normalizeToolkitSlug(searchContext.app)) {
          return jsonResult({
            error: "The requested app does not match the verified search result. Re-run composio_search_tools and reuse the returned dispatcher_input.",
          });
        }

        if (!searchContext.session_id && !searchSessionId) {
          return jsonResult({
            error: "The selected integration search result is missing a search session id. Re-run composio_search_tools and use the returned dispatcher_input.",
          });
        }
        if (searchSessionId && searchContext.session_id && searchSessionId !== searchContext.session_id) {
          return jsonResult({
            error: "The supplied search_session_id does not match the verified search result. Re-run composio_search_tools and reuse the returned dispatcher_input.",
          });
        }
        if (!requestedAccount && (connectedAccountId || accountIdentity)) {
          return jsonResult({
            error: "Use the canonical `account` field returned by composio_search_tools for gateway-backed integration execution. Do not supply legacy account identifiers.",
          });
        }

        const toolRouterResult = await executeComposioToolRouter({
          gatewayBaseUrl: params.serverConfig.gatewayBaseUrl,
          authorization: params.serverConfig.authorization,
          sessionId: searchContext.session_id ?? searchSessionId ?? "",
          toolName,
          input: toolArgs,
          account: requestedAccount,
          app: requestedApp,
        });
        const toolRouterDetails = asRecord(toolRouterResult.details);
        const failureKind = readString(toolRouterDetails?.failureKind ?? toolRouterDetails?.failure_kind);
        const shouldTryMcpFallback = toolRouterDetails?.status === "error"
          && (failureKind === "session_issue" || failureKind === "connection_issue");
        if (shouldTryMcpFallback) {
          const activeConnections = await fetchGatewayActiveConnectionsForToolkit({
            gatewayBaseUrl: params.serverConfig.gatewayBaseUrl,
            authorization: params.serverConfig.authorization,
            app: requestedApp,
          });
          const fallbackSelection = resolveGatewayMcpFallbackSelection({
            activeConnections: activeConnections ?? [],
            requestedAccount,
          });
          if (fallbackSelection.canFallback) {
            const mcpResult = await executeComposioTool({
              url: params.serverConfig.url,
              authorization: params.serverConfig.authorization,
              toolName,
              input: toolArgs,
              connectedAccountId: fallbackSelection.connectedAccountId,
              app: requestedApp,
              accountIdentity: fallbackSelection.accountIdentity,
            });
            const mcpDetails = asRecord(mcpResult.details);
            return {
              ...mcpResult,
              details: {
                ...(mcpDetails ?? {}),
                composioBridge: true,
                composioMode: "gateway_mcp_fallback",
                fallbackFrom: "gateway_tool_router",
                toolRouterSessionId: searchContext.session_id ?? searchSessionId ?? "",
                ...(failureKind ? { failureKind } : {}),
              },
            };
          }
        }
        return toolRouterResult;
      },
    } as AnyAgentTool,
  ];
}

export function registerCuratedComposioBridge(api: any, fallbackGatewayUrl: string) {
  const workspaceDir = resolveWorkspaceDir(api);
  const serverConfig = resolveComposioServerConfig(api, fallbackGatewayUrl);
  if (!workspaceDir || !serverConfig?.url) {
    return;
  }

  const searchContextSecret = createComposioSearchContextSecret({
    workspaceDir,
    gatewayUrl: resolveGatewayBaseUrl(serverConfig.url, fallbackGatewayUrl),
    apiKey: resolveConfiguredApiKey(api) ?? null,
  });
  const tools = createRegisteredComposioTools({
    serverConfig: {
      ...serverConfig,
      gatewayBaseUrl: resolveGatewayBaseUrl(serverConfig.url, fallbackGatewayUrl),
    },
    searchContextSecret,
  });
  for (const tool of tools) {
    api.registerTool(tool);
  }

  api.logger?.info?.(
    `[dench-ai-gateway] registered ${tools.length} managed ${DENCH_INTEGRATIONS_DISPLAY_NAME} bridge tool using gateway-backed search context`,
  );
}
