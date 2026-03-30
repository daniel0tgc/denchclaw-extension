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

export type IntegrationToggleResult = {
  state: IntegrationsState;
  changed: boolean;
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

type WebSearchConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]
>;

const DEFAULT_GATEWAY_URL = "https://gateway.merseoriginals.com";
const DEFAULT_FALLBACK_PROVIDER = "duckduckgo";
const METADATA_FILENAME = ".dench-integrations.json";
const EXA_PLUGIN_ID = "exa-search";
const APOLLO_PLUGIN_ID = "apollo-enrichment";

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

export function writeOpenClawConfigForIntegrations(config: OpenClawConfig): void {
  const configPath = openClawConfigPath();
  const dirPath = resolveOpenClawStateDir();
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
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

function ensurePluginsConfig(config: OpenClawConfig): NonNullable<OpenClawConfig["plugins"]> {
  if (!config.plugins) {
    config.plugins = {};
  }
  return config.plugins;
}

function ensureToolsConfig(config: OpenClawConfig): NonNullable<OpenClawConfig["tools"]> {
  if (!config.tools) {
    config.tools = {};
  }
  return config.tools;
}

function ensureWebSearchConfig(config: OpenClawConfig): WebSearchConfig {
  const tools = ensureToolsConfig(config);
  if (!tools.web) {
    tools.web = {};
  }
  if (!tools.web.search) {
    tools.web.search = {};
  }
  return tools.web.search;
}

function ensureStringList(target: unknown): string[] {
  return Array.isArray(target) ? readStringList(target) : [];
}

function setStringList(target: string[], nextValues: string[]): boolean {
  const next = Array.from(new Set(nextValues.filter(Boolean)));
  if (target.length === next.length && target.every((value, index) => value === next[index])) {
    return false;
  }
  target.length = 0;
  target.push(...next);
  return true;
}

function addUnique(list: string[], value: string): boolean {
  if (list.includes(value)) {
    return false;
  }
  list.push(value);
  return true;
}

function removeValue(list: string[], value: string): boolean {
  const next = list.filter((item) => item !== value);
  return setStringList(list, next);
}

function ensurePluginRegistration(config: OpenClawConfig, pluginId: string): boolean {
  const plugins = ensurePluginsConfig(config);
  const allow = ensureStringList(plugins.allow);
  const loadPaths = ensureStringList(plugins.load?.paths);
  plugins.allow = allow;
  if (!plugins.load) {
    plugins.load = {};
  }
  plugins.load.paths = loadPaths;
  if (!plugins.entries) {
    plugins.entries = {};
  }
  if (!plugins.installs) {
    plugins.installs = {};
  }

  let changed = false;
  const installPath = join(resolveOpenClawStateDir(), "extensions", pluginId);
  const sourcePath = join(process.cwd(), "extensions", pluginId);
  const pluginExists = existsSync(installPath);

  changed = addUnique(allow, pluginId) || changed;

  if (!plugins.entries[pluginId] || !asRecord(plugins.entries[pluginId])) {
    plugins.entries[pluginId] = { enabled: true };
    changed = true;
  }
  const entry = asRecord(plugins.entries[pluginId]);
  if (entry && entry.enabled !== true) {
    entry.enabled = true;
    changed = true;
  }

  if (pluginExists) {
    changed = addUnique(loadPaths, installPath) || changed;
    const install = asRecord(plugins.installs[pluginId]);
    if (!install) {
      plugins.installs[pluginId] = { installPath, sourcePath };
      changed = true;
    } else {
      if (install.installPath !== installPath) {
        install.installPath = installPath;
        changed = true;
      }
      if (install.sourcePath !== sourcePath) {
        install.sourcePath = sourcePath;
        changed = true;
      }
    }
  }

  return changed;
}

function setPluginEnabled(config: OpenClawConfig, pluginId: string, enabled: boolean): boolean {
  const plugins = ensurePluginsConfig(config);
  if (!plugins.entries) {
    plugins.entries = {};
  }
  let changed = false;
  const existing = asRecord(plugins.entries[pluginId]);
  if (!existing) {
    plugins.entries[pluginId] = { enabled };
    changed = true;
  } else if (existing.enabled !== enabled) {
    existing.enabled = enabled;
    changed = true;
  }
  return changed;
}

function setWebSearchPolicy(config: OpenClawConfig, params: {
  enabled: boolean;
  denied: boolean;
  provider?: string;
}): boolean {
  let changed = false;
  const tools = ensureToolsConfig(config);
  const deny = ensureStringList(tools.deny);
  tools.deny = deny;
  const webSearch = ensureWebSearchConfig(config);

  if (webSearch.enabled !== params.enabled) {
    webSearch.enabled = params.enabled;
    changed = true;
  }
  if (params.provider && webSearch.provider !== params.provider) {
    webSearch.provider = params.provider;
    changed = true;
  }
  if (params.denied) {
    changed = addUnique(deny, "web_search") || changed;
  } else {
    changed = removeValue(deny, "web_search") || changed;
  }
  return changed;
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

function resolveDenchApiKey(config: OpenClawConfig): string | null {
  const provider = asRecord(asRecord(config.models?.providers)?.["dench-cloud"]);
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

function ensureTtsConfig(config: OpenClawConfig): Record<string, unknown> {
  if (!config.messages) {
    config.messages = {};
  }
  if (!config.messages.tts) {
    config.messages.tts = {};
  }
  return config.messages.tts;
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
  const plugin = readPluginState(config, APOLLO_PLUGIN_ID);
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

export function setExaIntegrationEnabled(enabled: boolean): IntegrationToggleResult {
  const config = readOpenClawConfigForIntegrations();
  const metadata = readIntegrationsMetadata();
  let changed = false;

  if (enabled) {
    changed = ensurePluginRegistration(config, EXA_PLUGIN_ID) || changed;
    changed = setPluginEnabled(config, EXA_PLUGIN_ID, true) || changed;
    changed = setWebSearchPolicy(config, { enabled: false, denied: true }) || changed;
  } else {
    changed = setPluginEnabled(config, EXA_PLUGIN_ID, false) || changed;
    changed = setWebSearchPolicy(config, {
      enabled: true,
      denied: false,
      provider: DEFAULT_FALLBACK_PROVIDER,
    }) || changed;
  }

  const nextMetadata: DenchIntegrationMetadata = {
    ...metadata,
    schemaVersion: 1,
    exa: {
      ownsSearch: enabled,
      fallbackProvider: DEFAULT_FALLBACK_PROVIDER,
    },
  };
  if (JSON.stringify(nextMetadata) !== JSON.stringify(metadata)) {
    writeIntegrationsMetadata(nextMetadata);
    changed = true;
  }

  if (changed) {
    writeOpenClawConfigForIntegrations(config);
  }

  return {
    state: getIntegrationsState(),
    changed,
  };
}

export function setApolloIntegrationEnabled(enabled: boolean): IntegrationToggleResult {
  const config = readOpenClawConfigForIntegrations();
  let changed = false;

  if (enabled) {
    changed = ensurePluginRegistration(config, APOLLO_PLUGIN_ID) || changed;
    changed = setPluginEnabled(config, APOLLO_PLUGIN_ID, true) || changed;
  } else {
    changed = setPluginEnabled(config, APOLLO_PLUGIN_ID, false) || changed;
  }

  if (changed) {
    writeOpenClawConfigForIntegrations(config);
  }

  return {
    state: getIntegrationsState(),
    changed,
  };
}

export function setElevenLabsIntegrationEnabled(enabled: boolean): IntegrationToggleResult {
  const config = readOpenClawConfigForIntegrations();
  const tts = ensureTtsConfig(config);
  const gatewayBaseUrl = resolveGatewayBaseUrl(config) ?? DEFAULT_GATEWAY_URL;
  const denchApiKey = resolveDenchApiKey(config);
  let changed = false;

  if (enabled) {
    const existing = asRecord(tts.elevenlabs);
    if (!existing) {
      tts.elevenlabs = {};
    }
    const elevenlabs = asRecord(tts.elevenlabs);
    if (elevenlabs && elevenlabs.baseUrl !== gatewayBaseUrl) {
      elevenlabs.baseUrl = gatewayBaseUrl;
      changed = true;
    }
    if (elevenlabs && denchApiKey && elevenlabs.apiKey !== denchApiKey) {
      elevenlabs.apiKey = denchApiKey;
      changed = true;
    }
  } else {
    const elevenlabs = asRecord(tts.elevenlabs);
    if (elevenlabs) {
      if (elevenlabs.baseUrl === gatewayBaseUrl || elevenlabs.baseUrl === DEFAULT_GATEWAY_URL) {
        delete elevenlabs.baseUrl;
        changed = true;
      }
      if (denchApiKey && elevenlabs.apiKey === denchApiKey) {
        delete elevenlabs.apiKey;
        changed = true;
      }
      if (Object.keys(elevenlabs).length === 0) {
        delete tts.elevenlabs;
        changed = true;
      }
    }
  }

  if (changed) {
    writeOpenClawConfigForIntegrations(config);
  }

  return {
    state: getIntegrationsState(),
    changed,
  };
}
