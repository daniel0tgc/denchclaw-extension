import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_GATEWAY_URL = "https://gateway.merseoriginals.com";
const AUTH_PROFILES_REL = path.join("agents", "main", "agent", "auth-profiles.json");

/**
 * Read the Dench Cloud API key from the single source of truth
 * (`auth-profiles.json`), falling back to environment variables.
 */
export function readDenchAuthProfileKey(): string | undefined {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (stateDir) {
    const key = readKeyFromAuthProfiles(path.join(stateDir, AUTH_PROFILES_REL));
    if (key) return key;
  }
  return envFallback();
}

export function readKeyFromAuthProfiles(authPath: string): string | undefined {
  try {
    if (!existsSync(authPath)) return undefined;
    const raw = JSON.parse(readFileSync(authPath, "utf-8"));
    const key = raw?.profiles?.["dench-cloud:default"]?.key;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

function envFallback(): string | undefined {
  return process.env.DENCH_CLOUD_API_KEY?.trim() || process.env.DENCH_API_KEY?.trim() || undefined;
}

/**
 * Resolve the Dench Cloud gateway URL from plugin config or environment,
 * falling back to the production default.
 */
export function resolveDenchGatewayUrl(pluginConfig?: Record<string, unknown>): string {
  const configured = pluginConfig?.gatewayUrl;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return process.env.DENCH_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL;
}
