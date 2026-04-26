import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";

type UnknownRecord = Record<string, unknown>;

export type McpServerConfig = {
  url: string;
  transport: string;
  headers?: Record<string, string>;
};

export type McpServerEntry = {
  key: string;
  url: string;
  transport: string;
  hasAuth: boolean;
};

export class McpServerError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "McpServerError";
    this.status = status;
  }
}

const RESERVED_MCP_SERVER_KEYS = new Set(["composio"]);
const MCP_SERVER_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const REMOTE_MCP_TRANSPORT = "streamable-http";

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function openClawConfigPath(): string {
  return join(resolveOpenClawStateDir(), "openclaw.json");
}

function readConfig(): UnknownRecord {
  const configPath = openClawConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return (JSON.parse(readFileSync(configPath, "utf-8")) as UnknownRecord) ?? {};
  } catch {
    return {};
  }
}

function writeConfig(config: UnknownRecord): void {
  const stateDir = resolveOpenClawStateDir();
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  writeFileSync(openClawConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function ensureRecord(parent: UnknownRecord, key: string): UnknownRecord {
  const existing = asRecord(parent[key]);
  if (existing) {
    return existing;
  }
  const fresh: UnknownRecord = {};
  parent[key] = fresh;
  return fresh;
}

function assertServerKey(key: string): string {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    throw new McpServerError(400, "Field 'key' is required.");
  }
  if (!MCP_SERVER_KEY_PATTERN.test(normalizedKey)) {
    throw new McpServerError(
      400,
      "Field 'key' must use only letters, numbers, hyphens, or underscores.",
    );
  }
  if (RESERVED_MCP_SERVER_KEYS.has(normalizedKey)) {
    throw new McpServerError(400, `MCP server '${normalizedKey}' is managed internally.`);
  }
  return normalizedKey;
}

function normalizeTransport(transport?: string): string {
  const normalizedTransport = transport?.trim() || REMOTE_MCP_TRANSPORT;
  if (normalizedTransport !== REMOTE_MCP_TRANSPORT) {
    throw new McpServerError(
      400,
      `Only '${REMOTE_MCP_TRANSPORT}' transport is supported in Cloud settings.`,
    );
  }
  return normalizedTransport;
}

function normalizeUrl(url: string): string {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    throw new McpServerError(400, "Field 'url' is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new McpServerError(400, "Field 'url' must be a valid HTTP or HTTPS URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpServerError(400, "Field 'url' must use the http or https protocol.");
  }

  return parsed.toString();
}

function formatAuthorizationHeader(authToken?: string | null): string | null {
  const normalizedToken = authToken?.trim();
  if (!normalizedToken) {
    return null;
  }
  const tokenWithoutPrefix = normalizedToken.replace(/^Bearer\s+/iu, "").trim();
  if (!tokenWithoutPrefix) {
    throw new McpServerError(400, "Field 'authToken' must not be empty.");
  }
  return `Bearer ${tokenWithoutPrefix}`;
}

function toServerEntry(key: string, rawServer: UnknownRecord): McpServerEntry | null {
  const url = readString(rawServer.url);
  const transport = readString(rawServer.transport);
  if (!url || !transport) {
    return null;
  }

  const headers = asRecord(rawServer.headers);
  return {
    key,
    url,
    transport,
    hasAuth: Boolean(readString(headers?.Authorization)),
  };
}

export function listMcpServers(): McpServerEntry[] {
  const config = readConfig();
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers);
  if (!servers) {
    return [];
  }

  return Object.entries(servers)
    .filter(([key]) => !RESERVED_MCP_SERVER_KEYS.has(key))
    .map(([key, rawServer]) => {
      const server = asRecord(rawServer);
      return server ? toServerEntry(key, server) : null;
    })
    .filter((server): server is McpServerEntry => Boolean(server))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function addMcpServer(input: {
  key: string;
  url: string;
  transport?: string;
  authToken?: string | null;
}): McpServerEntry {
  const key = assertServerKey(input.key);
  const url = normalizeUrl(input.url);
  const transport = normalizeTransport(input.transport);
  const authorizationHeader = formatAuthorizationHeader(input.authToken);

  const config = readConfig();
  const mcp = ensureRecord(config, "mcp");
  const servers = ensureRecord(mcp, "servers");

  if (asRecord(servers[key])) {
    throw new McpServerError(409, `MCP server '${key}' already exists.`);
  }

  const nextServer: McpServerConfig = {
    url,
    transport,
    ...(authorizationHeader
      ? { headers: { Authorization: authorizationHeader } }
      : {}),
  };
  servers[key] = nextServer;

  writeConfig(config);
  return {
    key,
    url,
    transport,
    hasAuth: Boolean(authorizationHeader),
  };
}

export function removeMcpServer(key: string): void {
  const normalizedKey = assertServerKey(key);
  const config = readConfig();
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers);

  if (!servers || !asRecord(servers[normalizedKey])) {
    throw new McpServerError(404, `MCP server '${normalizedKey}' was not found.`);
  }

  delete servers[normalizedKey];

  if (Object.keys(servers).length === 0 && mcp) {
    delete mcp.servers;
  }
  if (mcp && Object.keys(mcp).length === 0) {
    delete config.mcp;
  }

  writeConfig(config);
}
