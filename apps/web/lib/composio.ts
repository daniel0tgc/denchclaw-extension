import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";

const DEFAULT_GATEWAY_URL = "https://gateway.merseoriginals.com";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComposioToolkit = {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  auth_schemes: string[];
  tools_count: number;
};

export type ComposioConnection = {
  id: string;
  toolkit_slug: string;
  toolkit_name: string;
  status: "ACTIVE" | "INITIATED" | "EXPIRED" | "FAILED" | "INACTIVE" | string;
  created_at: string;
  account_label?: string | null;
  account_name?: string | null;
  account_email?: string | null;
  external_account_id?: string | null;
};

export type ComposioToolkitsResponse = {
  items: ComposioToolkit[];
  cursor: string | null;
  total: number;
  categories: string[];
};

export type ComposioConnectionsResponse = {
  items: ComposioConnection[];
};

export type ComposioConnectResponse = {
  redirect_url: string;
  connection_id: string | null;
};

export type ComposioState = {
  eligible: boolean;
  lockReason: "missing_dench_key" | "dench_not_primary" | null;
  lockBadge: string | null;
  toolkits: ComposioToolkit[];
  connections: ComposioConnection[];
  categories: string[];
};

export type NormalizedComposioConnection = ComposioConnection & {
  normalized_toolkit_slug: string;
  normalized_status: string;
  is_active: boolean;
  account_identity: string;
  display_label: string;
};

export function normalizeComposioToolkitSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function normalizeComposioConnectionStatus(status: unknown): string {
  return typeof status === "string" && status.trim()
    ? status.trim().toUpperCase()
    : "UNKNOWN";
}

function buildComposioConnectionDisplayLabel(connection: ComposioConnection): string {
  const label = [
    connection.account_label,
    connection.account_name,
    connection.account_email,
  ].find((value) => typeof value === "string" && value.trim());

  if (label) {
    return label;
  }

  return `Connection ${connection.id.slice(-6)}`;
}

function buildComposioConnectionIdentity(connection: ComposioConnection): string {
  const stableIdentity = [
    connection.external_account_id,
    connection.account_email,
    connection.account_name,
    connection.account_label,
  ].find((value) => typeof value === "string" && value.trim());

  if (stableIdentity) {
    return `${normalizeComposioToolkitSlug(connection.toolkit_slug)}:${stableIdentity.trim().toLowerCase()}`;
  }

  return `${normalizeComposioToolkitSlug(connection.toolkit_slug)}:${connection.id}`;
}

export function normalizeComposioConnection(
  connection: ComposioConnection,
): NormalizedComposioConnection {
  const normalized_status = normalizeComposioConnectionStatus(connection.status);
  return {
    ...connection,
    normalized_toolkit_slug: normalizeComposioToolkitSlug(connection.toolkit_slug),
    normalized_status,
    is_active: normalized_status === "ACTIVE",
    account_identity: buildComposioConnectionIdentity(connection),
    display_label: buildComposioConnectionDisplayLabel(connection),
  };
}

function parseComposioConnectionTime(connection: ComposioConnection): number {
  const timestamp = Date.parse(connection.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortComposioConnections(
  left: NormalizedComposioConnection,
  right: NormalizedComposioConnection,
): number {
  if (left.is_active !== right.is_active) {
    return left.is_active ? -1 : 1;
  }

  const timeDiff = parseComposioConnectionTime(right) - parseComposioConnectionTime(left);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  return left.display_label.localeCompare(right.display_label);
}

export function normalizeComposioConnections(
  connections: ComposioConnection[],
): NormalizedComposioConnection[] {
  return connections.map(normalizeComposioConnection).sort(sortComposioConnections);
}

// ---------------------------------------------------------------------------
// Config resolution (mirrors integrations.ts patterns)
// ---------------------------------------------------------------------------

function readConfig(): UnknownRecord {
  const configPath = join(resolveOpenClawStateDir(), "openclaw.json");
  if (!existsSync(configPath)) return {};
  try {
    return (JSON.parse(readFileSync(configPath, "utf-8")) as UnknownRecord) ?? {};
  } catch {
    return {};
  }
}

export function resolveComposioGatewayUrl(): string {
  const config = readConfig();
  const plugins = asRecord(config.plugins);
  const pluginEntries = asRecord(plugins?.entries);
  const gatewayConfig = asRecord(asRecord(pluginEntries?.["dench-ai-gateway"])?.config);
  return (
    readString(gatewayConfig?.gatewayUrl) ||
    process.env.DENCH_GATEWAY_URL?.trim() ||
    DEFAULT_GATEWAY_URL
  );
}

export function resolveComposioApiKey(): string | null {
  const config = readConfig();
  const models = asRecord(config.models);
  const provider = asRecord(asRecord(models?.providers)?.["dench-cloud"]);
  if (readString(provider?.apiKey)) {
    return readString(provider?.apiKey) ?? null;
  }
  if (process.env.DENCH_CLOUD_API_KEY?.trim()) {
    return process.env.DENCH_CLOUD_API_KEY.trim();
  }
  if (process.env.DENCH_API_KEY?.trim()) {
    return process.env.DENCH_API_KEY.trim();
  }
  return null;
}

export function resolveComposioEligibility(): {
  eligible: boolean;
  lockReason: "missing_dench_key" | "dench_not_primary" | null;
  lockBadge: string | null;
} {
  const config = readConfig();
  const apiKey = resolveComposioApiKey();
  if (!apiKey) {
    return {
      eligible: false,
      lockReason: "missing_dench_key",
      lockBadge: "Get Dench Cloud API Key",
    };
  }
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const model = defaults?.model;
  const primary = typeof model === "string"
    ? readString(model)
    : readString(asRecord(model)?.primary);
  if (!primary?.startsWith("dench-cloud/")) {
    return {
      eligible: false,
      lockReason: "dench_not_primary",
      lockBadge: "Use Dench Cloud",
    };
  }
  return { eligible: true, lockReason: null, lockBadge: null };
}

// ---------------------------------------------------------------------------
// Gateway client helpers
// ---------------------------------------------------------------------------

async function gatewayFetch(
  gatewayUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${gatewayUrl}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...init?.headers,
    },
  });
}

export type FetchToolkitsOptions = {
  search?: string;
  category?: string;
  cursor?: string;
  limit?: number;
};

export async function fetchComposioToolkits(
  gatewayUrl: string,
  apiKey: string,
  options?: FetchToolkitsOptions,
): Promise<ComposioToolkitsResponse> {
  const params = new URLSearchParams();
  if (options?.search) params.set("search", options.search);
  if (options?.category) params.set("category", options.category);
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  const path = `/v1/composio/toolkits${qs ? `?${qs}` : ""}`;
  const res = await gatewayFetch(gatewayUrl, apiKey, path);
  if (!res.ok) {
    throw new Error(`Failed to fetch toolkits (HTTP ${res.status})`);
  }
  return res.json() as Promise<ComposioToolkitsResponse>;
}

export async function fetchComposioConnections(
  gatewayUrl: string,
  apiKey: string,
): Promise<ComposioConnectionsResponse> {
  const res = await gatewayFetch(gatewayUrl, apiKey, "/v1/composio/connections");
  if (!res.ok) {
    throw new Error(`Failed to fetch connections (HTTP ${res.status})`);
  }
  return res.json() as Promise<ComposioConnectionsResponse>;
}

export async function initiateComposioConnect(
  gatewayUrl: string,
  apiKey: string,
  toolkit: string,
  callbackUrl: string,
): Promise<ComposioConnectResponse> {
  const res = await gatewayFetch(gatewayUrl, apiKey, "/v1/composio/connect", {
    method: "POST",
    body: JSON.stringify({ toolkit, callback_url: callbackUrl }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Failed to initiate connection for ${toolkit} (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return res.json() as Promise<ComposioConnectResponse>;
}

export async function disconnectComposioApp(
  gatewayUrl: string,
  apiKey: string,
  connectionId: string,
): Promise<{ deleted: boolean }> {
  const res = await gatewayFetch(
    gatewayUrl,
    apiKey,
    `/v1/composio/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(`Failed to disconnect (HTTP ${res.status})`);
  }
  return res.json() as Promise<{ deleted: boolean }>;
}
