/**
 * Sidecar storage for OAuth secrets attached to user-added MCP servers.
 *
 * Lives at `${resolveOpenClawStateDir()}/.mcp-secrets.json` with mode 0600.
 *
 * We deliberately keep secrets out of `openclaw.json`:
 *   - The agent runtime reads `openclaw.json` and surfaces parts of it in
 *     debug logs and exports; refresh tokens must never end up there.
 *   - Some users sync `openclaw.json` to share configuration; secrets must
 *     stay machine-local.
 *
 * The shape stored per server key is everything the OAuth callback +
 * refresh paths need to recover an access token without touching the
 * upstream auth server's user consent prompt:
 *
 *   {
 *     clientId, clientSecret?,
 *     refreshToken,
 *     tokenExpiresAt,
 *     asMetadataUrl,         // resolved RFC 8414 metadata document URL
 *     authServerIssuer?,     // best-effort identifier for diagnostics
 *     registeredRedirectUri?, // redirect URI used for DCR client registration
 *
 *     // Transient (cleared after `exchangeCodeForToken`):
 *     codeVerifier?,         // PKCE
 *     oauthState?,           // CSRF nonce
 *     redirectUri?,          // pinned at /connect/start time
 *
 *     scope?,                // retained for refresh-token grants
 *   }
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";

type UnknownRecord = Record<string, unknown>;

const SECRETS_FILENAME = ".mcp-secrets.json";
const SECRETS_FILE_MODE = 0o600;

export type McpServerSecret = {
  clientId: string;
  clientSecret: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  asMetadataUrl: string;
  authServerIssuer: string | null;
  /** Redirect URI registered with the OAuth client. */
  registeredRedirectUri: string | null;
  /** PKCE verifier — only present between /connect/start and /connect/callback. */
  codeVerifier: string | null;
  /** CSRF nonce — only present between /connect/start and /connect/callback. */
  oauthState: string | null;
  /** Redirect URI used at authorize time, must match at token exchange time. */
  redirectUri: string | null;
  /** Requested scope string at authorize time. */
  scope: string | null;
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function secretsPath(): string {
  return join(resolveOpenClawStateDir(), SECRETS_FILENAME);
}

function ensureStateDir(): void {
  const stateDir = resolveOpenClawStateDir();
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

function emptySecret(): McpServerSecret {
  return {
    clientId: "",
    clientSecret: null,
    refreshToken: null,
    tokenExpiresAt: null,
    asMetadataUrl: "",
    authServerIssuer: null,
    registeredRedirectUri: null,
    codeVerifier: null,
    oauthState: null,
    redirectUri: null,
    scope: null,
  };
}

function readAll(): Record<string, McpServerSecret> {
  const path = secretsPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return {};
    }
    const out: Record<string, McpServerSecret> = {};
    for (const [key, value] of Object.entries(record)) {
      const entry = asRecord(value);
      if (!entry) {
        continue;
      }
      out[key] = {
        clientId: readString(entry.clientId) ?? "",
        clientSecret: readString(entry.clientSecret) ?? null,
        refreshToken: readString(entry.refreshToken) ?? null,
        tokenExpiresAt: readString(entry.tokenExpiresAt) ?? null,
        asMetadataUrl: readString(entry.asMetadataUrl) ?? "",
        authServerIssuer: readString(entry.authServerIssuer) ?? null,
        registeredRedirectUri: readString(entry.registeredRedirectUri) ?? null,
        codeVerifier: readString(entry.codeVerifier) ?? null,
        oauthState: readString(entry.oauthState) ?? null,
        redirectUri: readString(entry.redirectUri) ?? null,
        scope: readString(entry.scope) ?? null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(secrets: Record<string, McpServerSecret>): void {
  ensureStateDir();
  const path = secretsPath();
  writeFileSync(path, JSON.stringify(secrets, null, 2) + "\n", "utf-8");
  // chmod 600 — best-effort; on platforms without POSIX semantics this is a
  // no-op, but on macOS/Linux it ensures the file is owner-only readable
  // even if the surrounding directory is more permissive.
  try {
    chmodSync(path, SECRETS_FILE_MODE);
  } catch {
    // ignore — chmod failure shouldn't block the OAuth flow
  }
}

export function getMcpServerSecret(key: string): McpServerSecret | null {
  return readAll()[key] ?? null;
}

export function setMcpServerSecret(
  key: string,
  patch: Partial<McpServerSecret>,
): McpServerSecret {
  const all = readAll();
  const current = all[key] ?? emptySecret();
  const next: McpServerSecret = { ...current, ...patch };
  all[key] = next;
  writeAll(all);
  return next;
}

export function deleteMcpServerSecret(key: string): void {
  const all = readAll();
  if (all[key]) {
    delete all[key];
    writeAll(all);
  }
}

/**
 * Wipe transient PKCE/state fields after a successful token exchange. Keeps
 * `clientId`/`clientSecret`/`refreshToken` etc. for future refresh calls.
 */
export function clearTransientOAuthFields(key: string): void {
  const all = readAll();
  const current = all[key];
  if (!current) {
    return;
  }
  all[key] = {
    ...current,
    codeVerifier: null,
    oauthState: null,
    redirectUri: null,
  };
  writeAll(all);
}
