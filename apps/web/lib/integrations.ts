import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";

export type DenchIntegrationId = "exa" | "apollo" | "elevenlabs";

export type DenchIntegrationMetadata = {
  schemaVersion: 1;
  exa?: {
    ownsSearch?: boolean;
    fallbackProvider?: string | null;
  };
  apollo?: Record<string, never>;
  elevenlabs?: Record<string, never>;
  future?: {
    composio?: {
      providers?: string[];
    };
  };
};

export type IntegrationAuthSummary = {
  configured: boolean;
  source: "config" | "env" | "missing";
};

export type IntegrationPluginState = {
  pluginId: string;
  configured: boolean;
  enabled: boolean;
  allowlisted: boolean;
  loadPathConfigured: boolean;
  installRecorded: boolean;
  installPath: string | null;
  installPathExists: boolean;
  sourcePath: string | null;
};

export type IntegrationHealthIssue =
  | "missing_plugin_entry"
  | "plugin_disabled"
  | "plugin_not_allowlisted"
  | "plugin_load_path_missing"
  | "plugin_install_missing"
  | "plugin_install_path_missing"
  | "missing_auth"
  | "missing_gateway"
  | "missing_override"
  | "built_in_search_still_enabled";

export type DenchIntegrationState = {
  id: DenchIntegrationId;
  label: string;
  enabled: boolean;
  available: boolean;
  gatewayBaseUrl: string | null;
  auth: IntegrationAuthSummary;
  plugin: IntegrationPluginState | null;
  managedByDench: boolean;
  healthIssues: IntegrationHealthIssue[];
  overrideActive?: boolean;
};

export type BuiltInSearchState = {
  enabled: boolean;
  denied: boolean;
  provider: string | null;
};

export type IntegrationsState = {
  metadata: DenchIntegrationMetadata;
  search: {
    builtIn: BuiltInSearchState;
    effectiveOwner: "exa" | "web_search" | "none";
  };
  integrations: DenchIntegrationState[];
};

type UnknownRecord = Record<string, unknown>;

type OpenClawConfig = {
  models?: {
    providers?: Record<string, unknown>;
  };
  messages?: {
    tts?: Record<string, unknown>;
  };
  plugins?: {
    allow?: unknown[];
    load?: {
      paths?: unknown[];
    };
    entries?: Record<string, unknown>;
    installs?: Record<string, unknown>;
  };
  tools?: {
    deny?: unknown[];
    web?: {
      search?: {
        enabled?: unknown;
        provider?: unknown;
      };
    };
  };
};

const DEFAULT_GATEWAY_URL = "https://gateway.merseoriginals.com";
const DEFAULT_FALLBACK_PROVIDER = "duckduckgo";
const METADATA_FILENAME = ".dench-integrations.json";

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => readString(item))
    .filter((item): item is string => Boolean(item));
}

function openClawConfigPath(): string {
  return join(resolveOpenClawStateDir(), "openclaw.json");
}

function integrationsMetadataPath(): string {
  return join(resolveOpenClawStateDir(), METADATA_FILENAME);
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function readOpenClawConfigForIntegrations(): OpenClawConfig {
  return readJsonFile<OpenClawConfig>(openClawConfigPath(), {});
}

export function readIntegrationsMetadata(): DenchIntegrationMetadata {
  const parsed = readJsonFile<DenchIntegrationMetadata | UnknownRecord>(
    integrationsMetadataPath(),
    { schemaVersion: 1 },
  );
  const schemaVersion =
    asRecord(parsed) && parsed.schemaVersion === 1 ? 1 : 1;
  return {
    schemaVersion,
    ...(asRecord(parsed)?.exa ? { exa: asRecord(parsed)?.exa as DenchIntegrationMetadata["exa"] } : {}),
    ...(asRecord(parsed)?.apollo ? { apollo: {} } : {}),
    ...(asRecord(parsed)?.elevenlabs ? { elevenlabs: {} } : {}),
    ...(asRecord(parsed)?.future ? { future: asRecord(parsed)?.future as DenchIntegrationMetadata["future"] } : {}),
  };
}

export function writeIntegrationsMetadata(metadata: DenchIntegrationMetadata): void {
  const filePath = integrationsMetadataPath();
  const dirPath = resolveOpenClawStateDir();
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
}

function resolveGatewayBaseUrl(config: OpenClawConfig): string | null {
  const pluginEntries = asRecord(config.plugins?.entries);
  const gatewayConfig = asRecord(asRecord(pluginEntries?.["dench-ai-gateway"])?.config);
  return (
    readString(gatewayConfig?.gatewayUrl) ||
    process.env.DENCH_GATEWAY_URL?.trim() ||
    DEFAULT_GATEWAY_URL
  );
}

function resolveDenchAuth(config: OpenClawConfig): IntegrationAuthSummary {
  const provider = asRecord(asRecord(config.models?.providers)?.["dench-cloud"]);
  if (readString(provider?.apiKey)) {
    return { configured: true, source: "config" };
  }
  if (process.env.DENCH_CLOUD_API_KEY?.trim() || process.env.DENCH_API_KEY?.trim()) {
    return { configured: true, source: "env" };
  }
  return { configured: false, source: "missing" };
}

function readPluginState(config: OpenClawConfig, pluginId: string): IntegrationPluginState {
  const entries = asRecord(config.plugins?.entries);
  const installs = asRecord(config.plugins?.installs);
  const allow = readStringList(config.plugins?.allow);
  const loadPaths = readStringList(config.plugins?.load?.paths);
  const entry = asRecord(entries?.[pluginId]);
  const install = asRecord(installs?.[pluginId]);
  const installPath = readString(install?.installPath) ?? null;
  const sourcePath = readString(install?.sourcePath) ?? null;

  return {
    pluginId,
    configured: Boolean(entry),
    enabled: entry?.enabled !== false && Boolean(entry),
    allowlisted: allow.includes(pluginId),
    loadPathConfigured: loadPaths.some((path) => path === installPath),
    installRecorded: Boolean(install),
    installPath,
    installPathExists: installPath ? existsSync(installPath) : false,
    sourcePath,
  };
}

function readBuiltInSearchState(config: OpenClawConfig): BuiltInSearchState {
  const deny = readStringList(config.tools?.deny);
  const searchConfig = config.tools?.web?.search;
  return {
    enabled: readBoolean(searchConfig?.enabled) !== false,
    denied: deny.includes("web_search"),
    provider: readString(searchConfig?.provider) ?? null,
  };
}

function resolveEffectiveSearchOwner(params: {
  exaState: DenchIntegrationState;
  builtInSearch: BuiltInSearchState;
}): "exa" | "web_search" | "none" {
  if (params.exaState.enabled && params.exaState.available && (params.builtInSearch.denied || !params.builtInSearch.enabled)) {
    return "exa";
  }
  if (params.builtInSearch.enabled && !params.builtInSearch.denied) {
    return "web_search";
  }
  return "none";
}

function buildExaState(
  config: OpenClawConfig,
  gatewayBaseUrl: string | null,
  auth: IntegrationAuthSummary,
  builtInSearch: BuiltInSearchState,
): DenchIntegrationState {
  const plugin = readPluginState(config, "exa-search");
  const healthIssues: IntegrationHealthIssue[] = [];
  if (!plugin.configured) healthIssues.push("missing_plugin_entry");
  if (plugin.configured && !plugin.enabled) healthIssues.push("plugin_disabled");
  if (!plugin.allowlisted) healthIssues.push("plugin_not_allowlisted");
  if (!plugin.loadPathConfigured) healthIssues.push("plugin_load_path_missing");
  if (!plugin.installRecorded) healthIssues.push("plugin_install_missing");
  if (plugin.installRecorded && !plugin.installPathExists) healthIssues.push("plugin_install_path_missing");
  if (!auth.configured) healthIssues.push("missing_auth");
  if (!gatewayBaseUrl) healthIssues.push("missing_gateway");
  if (plugin.enabled && builtInSearch.enabled && !builtInSearch.denied) {
    healthIssues.push("built_in_search_still_enabled");
  }

  const enabled = plugin.configured && plugin.enabled;
  const available =
    enabled &&
    plugin.allowlisted &&
    plugin.loadPathConfigured &&
    plugin.installRecorded &&
    plugin.installPathExists &&
    auth.configured &&
    Boolean(gatewayBaseUrl);

  return {
    id: "exa",
    label: "Exa Search",
    enabled,
    available,
    gatewayBaseUrl,
    auth,
    plugin,
    managedByDench: true,
    healthIssues,
  };
}

function buildApolloState(
  config: OpenClawConfig,
  gatewayBaseUrl: string | null,
  auth: IntegrationAuthSummary,
): DenchIntegrationState {
  const plugin = readPluginState(config, "apollo-enrichment");
  const healthIssues: IntegrationHealthIssue[] = [];
  if (!plugin.configured) healthIssues.push("missing_plugin_entry");
  if (plugin.configured && !plugin.enabled) healthIssues.push("plugin_disabled");
  if (!plugin.allowlisted) healthIssues.push("plugin_not_allowlisted");
  if (!plugin.loadPathConfigured) healthIssues.push("plugin_load_path_missing");
  if (!plugin.installRecorded) healthIssues.push("plugin_install_missing");
  if (plugin.installRecorded && !plugin.installPathExists) healthIssues.push("plugin_install_path_missing");
  if (!auth.configured) healthIssues.push("missing_auth");
  if (!gatewayBaseUrl) healthIssues.push("missing_gateway");

  const enabled = plugin.configured && plugin.enabled;
  const available =
    enabled &&
    plugin.allowlisted &&
    plugin.loadPathConfigured &&
    plugin.installRecorded &&
    plugin.installPathExists &&
    auth.configured &&
    Boolean(gatewayBaseUrl);

  return {
    id: "apollo",
    label: "Apollo Enrichment",
    enabled,
    available,
    gatewayBaseUrl,
    auth,
    plugin,
    managedByDench: true,
    healthIssues,
  };
}

function buildElevenLabsState(
  config: OpenClawConfig,
  gatewayBaseUrl: string | null,
  auth: IntegrationAuthSummary,
): DenchIntegrationState {
  const elevenlabs = asRecord(asRecord(config.messages)?.tts);
  const override = asRecord(elevenlabs?.elevenlabs);
  const overrideBaseUrl = readString(override?.baseUrl) ?? null;
  const overrideActive = Boolean(overrideBaseUrl && gatewayBaseUrl && overrideBaseUrl === gatewayBaseUrl);
  const healthIssues: IntegrationHealthIssue[] = [];
  if (!auth.configured) healthIssues.push("missing_auth");
  if (!gatewayBaseUrl) healthIssues.push("missing_gateway");
  if (!overrideActive) healthIssues.push("missing_override");

  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    enabled: overrideActive,
    available: auth.configured && Boolean(gatewayBaseUrl),
    gatewayBaseUrl: overrideBaseUrl ?? gatewayBaseUrl,
    auth,
    plugin: null,
    managedByDench: true,
    healthIssues,
    overrideActive,
  };
}

export function getIntegrationsState(): IntegrationsState {
  const config = readOpenClawConfigForIntegrations();
  const metadata = readIntegrationsMetadata();
  const gatewayBaseUrl = resolveGatewayBaseUrl(config);
  const auth = resolveDenchAuth(config);
  const builtInSearch = readBuiltInSearchState(config);
  const exa = buildExaState(config, gatewayBaseUrl, auth, builtInSearch);
  const apollo = buildApolloState(config, gatewayBaseUrl, auth);
  const elevenlabs = buildElevenLabsState(config, gatewayBaseUrl, auth);

  return {
    metadata: {
      schemaVersion: 1,
      exa: {
        ownsSearch: metadata.exa?.ownsSearch ?? false,
        fallbackProvider: metadata.exa?.fallbackProvider ?? DEFAULT_FALLBACK_PROVIDER,
      },
      ...(metadata.apollo ? { apollo: {} } : {}),
      ...(metadata.elevenlabs ? { elevenlabs: {} } : {}),
      ...(metadata.future ? { future: metadata.future } : {}),
    },
    search: {
      builtIn: builtInSearch,
      effectiveOwner: resolveEffectiveSearchOwner({ exaState: exa, builtInSearch }),
    },
    integrations: [exa, apollo, elevenlabs],
  };
}

export function getIntegrationState(id: DenchIntegrationId): DenchIntegrationState | undefined {
  return getIntegrationsState().integrations.find((integration) => integration.id === id);
}
