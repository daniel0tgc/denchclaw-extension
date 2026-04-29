/**
 * MCP OAuth 2.1 client utilities.
 *
 * Implements the discovery + dynamic-client-registration + PKCE pieces of
 * the MCP authorization spec, which composes:
 *
 *   - RFC 9728  : Protected Resource Metadata
 *   - RFC 8414  : Authorization Server Metadata
 *   - RFC 7591  : Dynamic Client Registration (DCR)
 *   - RFC 7636  : PKCE
 *   - RFC 6749  : OAuth 2.0 base
 *
 * The flow this module supports:
 *
 *   1. Server returns 401 with `WWW-Authenticate: Bearer resource_metadata=...`
 *      (parsed by mcp-probe.ts).
 *   2. `discoverOAuthMetadata` follows the resource_metadata URL, then the
 *      AS metadata document, returning both.
 *   3. `registerOAuthClient` runs DCR if the AS exposes a registration
 *      endpoint and we don't already have credentials cached.
 *   4. `buildAuthorizationUrl` generates a PKCE verifier + challenge, a CSRF
 *      `state`, and the URL the user's browser opens.
 *   5. After the user approves, the AS redirects to our callback with `code`
 *      + `state`; `exchangeCodeForToken` swaps that for an access_token.
 *
 * Network failures throw with descriptive messages — the call sites surface
 * them as `supportsOAuth: false, reason: "..."` to the UI rather than 500s.
 */

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

type UnknownRecord = Record<string, unknown>;

export type ProtectedResourceMetadata = {
  resource: string | null;
  authorizationServers: string[];
  scopesSupported: string[];
  bearerMethodsSupported: string[];
};

export type AuthorizationServerMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopesSupported: string[];
  responseTypesSupported: string[];
  grantTypesSupported: string[];
  codeChallengeMethodsSupported: string[];
  tokenEndpointAuthMethodsSupported: string[];
};

export type RegisteredClient = {
  clientId: string;
  clientSecret: string | null;
  registrationAccessToken: string | null;
  registrationClientUri: string | null;
};

export type AuthorizationRequestParams = {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  scope: string | null;
};

export type TokenResponse = {
  accessToken: string;
  tokenType: string;
  refreshToken: string | null;
  expiresIn: number | null;
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const s = readString(item);
    if (s) {
      out.push(s);
    }
  }
  return out;
}

export class McpOAuthError extends Error {
  reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "McpOAuthError";
    this.reason = reason;
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  context: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    throw new McpOAuthError(
      "network_error",
      `${context} request to ${url} failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new McpOAuthError(
      "http_error",
      `${context} request to ${url} returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new McpOAuthError(
      "invalid_json",
      `${context} response from ${url} was not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/**
 * Walk the RFC 9728 / RFC 8414 discovery chain starting from the
 * `resource_metadata` URL advertised in the MCP server's WWW-Authenticate
 * challenge.
 */
export async function discoverOAuthMetadata(
  resourceMetadataUrl: string,
  options?: { fetcher?: typeof fetch },
): Promise<{
  resource: ProtectedResourceMetadata;
  authServer: AuthorizationServerMetadata;
}> {
  const fetcher = options?.fetcher ?? fetch;

  const resourceRaw = await fetchJson(
    resourceMetadataUrl,
    { method: "GET", headers: { accept: "application/json" } },
    fetcher,
    "Protected resource metadata",
  );
  const resourceRec = asRecord(resourceRaw);
  if (!resourceRec) {
    throw new McpOAuthError(
      "invalid_resource_metadata",
      `Resource metadata at ${resourceMetadataUrl} was not a JSON object.`,
    );
  }
  const authorizationServers = readStringArray(resourceRec.authorization_servers);
  if (authorizationServers.length === 0) {
    throw new McpOAuthError(
      "no_authorization_servers",
      `Resource metadata at ${resourceMetadataUrl} did not list any authorization_servers.`,
    );
  }

  const resource: ProtectedResourceMetadata = {
    resource: readString(resourceRec.resource) ?? null,
    authorizationServers,
    scopesSupported: readStringArray(resourceRec.scopes_supported),
    bearerMethodsSupported: readStringArray(resourceRec.bearer_methods_supported),
  };

  // Try authorization servers in order; first one that yields valid metadata wins.
  let lastError: McpOAuthError | null = null;
  for (const issuer of authorizationServers) {
    try {
      const authServer = await fetchAuthorizationServerMetadata(issuer, fetcher);
      return { resource, authServer };
    } catch (error) {
      lastError = error instanceof McpOAuthError
        ? error
        : new McpOAuthError("unknown_error", error instanceof Error ? error.message : String(error));
    }
  }
  throw lastError ?? new McpOAuthError(
    "no_valid_authorization_server",
    "Could not load metadata for any advertised authorization server.",
  );
}

async function fetchAuthorizationServerMetadata(
  issuer: string,
  fetcher: typeof fetch,
): Promise<AuthorizationServerMetadata> {
  // Per RFC 8414, issuers with paths place the well-known segment before
  // the issuer path:
  //   https://example.com       → https://example.com/.well-known/oauth-authorization-server
  //   https://example.com/tenant → https://example.com/.well-known/oauth-authorization-server/tenant
  // Try OAuth metadata first, then OpenID Connect's well-known path as a
  // common fallback (some providers only expose OIDC).
  const candidates = buildMetadataUrls(issuer);
  let lastError: McpOAuthError | null = null;
  for (const url of candidates) {
    try {
      const raw = await fetchJson(
        url,
        { method: "GET", headers: { accept: "application/json" } },
        fetcher,
        "Authorization server metadata",
      );
      const rec = asRecord(raw);
      if (!rec) {
        lastError = new McpOAuthError(
          "invalid_as_metadata",
          `Authorization server metadata at ${url} was not a JSON object.`,
        );
        continue;
      }
      const authorizationEndpoint = readString(rec.authorization_endpoint);
      const tokenEndpoint = readString(rec.token_endpoint);
      if (!authorizationEndpoint || !tokenEndpoint) {
        lastError = new McpOAuthError(
          "incomplete_as_metadata",
          `Authorization server metadata at ${url} is missing authorization_endpoint or token_endpoint.`,
        );
        continue;
      }
      return {
        issuer: readString(rec.issuer) ?? issuer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint: readString(rec.registration_endpoint) ?? null,
        scopesSupported: readStringArray(rec.scopes_supported),
        responseTypesSupported: readStringArray(rec.response_types_supported),
        grantTypesSupported: readStringArray(rec.grant_types_supported),
        codeChallengeMethodsSupported: readStringArray(rec.code_challenge_methods_supported),
        tokenEndpointAuthMethodsSupported: readStringArray(
          rec.token_endpoint_auth_methods_supported,
        ),
      };
    } catch (error) {
      lastError = error instanceof McpOAuthError
        ? error
        : new McpOAuthError("unknown_error", error instanceof Error ? error.message : String(error));
    }
  }
  throw lastError ?? new McpOAuthError(
    "no_as_metadata",
    `Could not load authorization server metadata for issuer ${issuer}.`,
  );
}

function buildMetadataUrls(issuer: string): string[] {
  const trimmed = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  const pathAwareOAuth = buildPathAwareWellKnownUrl(
    trimmed,
    "oauth-authorization-server",
  );
  const pathAwareOidc = buildPathAwareWellKnownUrl(
    trimmed,
    "openid-configuration",
  );
  return [
    pathAwareOAuth,
    `${trimmed}/.well-known/oauth-authorization-server`,
    pathAwareOidc,
    `${trimmed}/.well-known/openid-configuration`,
  ].filter((url, index, urls): url is string => Boolean(url) && urls.indexOf(url) === index);
}

function buildPathAwareWellKnownUrl(
  issuer: string,
  wellKnownSuffix: string,
): string | null {
  try {
    const parsed = new URL(issuer);
    const issuerPath = parsed.pathname === "/"
      ? ""
      : parsed.pathname.replace(/\/$/u, "");
    parsed.pathname = `/.well-known/${wellKnownSuffix}${issuerPath}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Run RFC 7591 dynamic client registration. Throws `McpOAuthError` with
 * `reason: "no_registration_endpoint"` if the AS doesn't support DCR — the
 * caller then falls back to the paste-a-token UI.
 */
export async function registerOAuthClient(params: {
  asMetadata: AuthorizationServerMetadata;
  redirectUri: string;
  clientName: string;
  scope?: string | null;
  fetcher?: typeof fetch;
}): Promise<RegisteredClient> {
  const fetcher = params.fetcher ?? fetch;
  const endpoint = params.asMetadata.registrationEndpoint;
  if (!endpoint) {
    throw new McpOAuthError(
      "no_registration_endpoint",
      `Authorization server ${params.asMetadata.issuer} does not advertise a registration_endpoint.`,
    );
  }

  const body: UnknownRecord = {
    redirect_uris: [params.redirectUri],
    token_endpoint_auth_method:
      params.asMetadata.tokenEndpointAuthMethodsSupported.includes("none")
        ? "none"
        : params.asMetadata.tokenEndpointAuthMethodsSupported[0] ?? "client_secret_post",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: params.clientName,
    application_type: "web",
  };
  if (params.scope) {
    body.scope = params.scope;
  }

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new McpOAuthError(
      "registration_network_error",
      `DCR request to ${endpoint} failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new McpOAuthError(
      "registration_failed",
      `DCR request to ${endpoint} returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch (error) {
    throw new McpOAuthError(
      "registration_invalid_json",
      `DCR response was not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  const rec = asRecord(parsed);
  const clientId = readString(rec?.client_id);
  if (!clientId) {
    throw new McpOAuthError(
      "registration_missing_client_id",
      "DCR response did not include a client_id.",
    );
  }
  return {
    clientId,
    clientSecret: readString(rec?.client_secret) ?? null,
    registrationAccessToken: readString(rec?.registration_access_token) ?? null,
    registrationClientUri: readString(rec?.registration_client_uri) ?? null,
  };
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  // 32 bytes → 43-char base64url string, well within RFC 7636's 43..128 range.
  return base64UrlEncode(randomBytes(32));
}

export function deriveCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(24));
}

export function buildAuthorizationUrl(params: {
  asMetadata: AuthorizationServerMetadata;
  client: RegisteredClient;
  redirectUri: string;
  scope?: string | null;
  resource?: string | null;
  codeVerifier?: string;
  state?: string;
}): AuthorizationRequestParams {
  const codeVerifier = params.codeVerifier ?? generateCodeVerifier();
  const codeChallenge = deriveCodeChallenge(codeVerifier);
  const state = params.state ?? generateState();

  const url = new URL(params.asMetadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.client.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.scope) {
    url.searchParams.set("scope", params.scope);
  }
  if (params.resource) {
    // RFC 8707 — bind the access token to the protected resource.
    url.searchParams.set("resource", params.resource);
  }

  return {
    authorizationUrl: url.toString(),
    state,
    codeVerifier,
    redirectUri: params.redirectUri,
    scope: params.scope ?? null,
  };
}

function parseTokenResponse(rec: UnknownRecord, context: string): TokenResponse {
  const accessToken = readString(rec.access_token);
  if (!accessToken) {
    throw new McpOAuthError(
      "missing_access_token",
      `${context} response did not include an access_token.`,
    );
  }
  const tokenType = readString(rec.token_type) ?? "Bearer";
  const expiresInRaw = rec.expires_in;
  const expiresIn = typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw)
    ? expiresInRaw
    : null;
  return {
    accessToken,
    tokenType,
    refreshToken: readString(rec.refresh_token) ?? null,
    expiresIn,
    scope: readString(rec.scope) ?? null,
  };
}

async function postTokenEndpoint(params: {
  endpoint: string;
  formBody: URLSearchParams;
  client: { clientId: string; clientSecret: string | null };
  authMethod: string;
  fetcher: typeof fetch;
  context: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams(params.formBody);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (params.authMethod === "client_secret_basic" && params.client.clientSecret) {
    const encoded = Buffer.from(`${params.client.clientId}:${params.client.clientSecret}`).toString("base64");
    headers.authorization = `Basic ${encoded}`;
  } else {
    body.set("client_id", params.client.clientId);
    if (params.client.clientSecret) {
      body.set("client_secret", params.client.clientSecret);
    }
  }
  let response: Response;
  try {
    response = await params.fetcher(params.endpoint, {
      method: "POST",
      headers,
      body,
    });
  } catch (error) {
    throw new McpOAuthError(
      "token_network_error",
      `${params.context} request to ${params.endpoint} failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new McpOAuthError(
      "token_request_failed",
      `${params.context} request to ${params.endpoint} returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch (error) {
    throw new McpOAuthError(
      "token_invalid_json",
      `${params.context} response was not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  const rec = asRecord(parsed);
  if (!rec) {
    throw new McpOAuthError(
      "token_invalid_payload",
      `${params.context} response was not a JSON object.`,
    );
  }
  return parseTokenResponse(rec, params.context);
}

function pickTokenAuthMethod(asMetadata: AuthorizationServerMetadata, hasSecret: boolean): string {
  const supported = asMetadata.tokenEndpointAuthMethodsSupported;
  if (!hasSecret) {
    if (supported.length === 0 || supported.includes("none")) {
      return "none";
    }
    return supported.includes("client_secret_post") ? "client_secret_post" : supported[0];
  }
  if (supported.includes("client_secret_basic")) {
    return "client_secret_basic";
  }
  if (supported.includes("client_secret_post")) {
    return "client_secret_post";
  }
  return supported[0] ?? "client_secret_basic";
}

export async function exchangeCodeForToken(params: {
  asMetadata: AuthorizationServerMetadata;
  client: RegisteredClient;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string | null;
  fetcher?: typeof fetch;
}): Promise<TokenResponse> {
  const fetcher = params.fetcher ?? fetch;
  const formBody = new URLSearchParams();
  formBody.set("grant_type", "authorization_code");
  formBody.set("code", params.code);
  formBody.set("redirect_uri", params.redirectUri);
  formBody.set("code_verifier", params.codeVerifier);
  if (params.resource) {
    formBody.set("resource", params.resource);
  }

  return postTokenEndpoint({
    endpoint: params.asMetadata.tokenEndpoint,
    formBody,
    client: params.client,
    authMethod: pickTokenAuthMethod(params.asMetadata, Boolean(params.client.clientSecret)),
    fetcher,
    context: "Token exchange",
  });
}

export async function refreshAccessToken(params: {
  asMetadata: AuthorizationServerMetadata;
  client: RegisteredClient;
  refreshToken: string;
  scope?: string | null;
  resource?: string | null;
  fetcher?: typeof fetch;
}): Promise<TokenResponse> {
  const fetcher = params.fetcher ?? fetch;
  const formBody = new URLSearchParams();
  formBody.set("grant_type", "refresh_token");
  formBody.set("refresh_token", params.refreshToken);
  if (params.scope) {
    formBody.set("scope", params.scope);
  }
  if (params.resource) {
    formBody.set("resource", params.resource);
  }
  return postTokenEndpoint({
    endpoint: params.asMetadata.tokenEndpoint,
    formBody,
    client: params.client,
    authMethod: pickTokenAuthMethod(params.asMetadata, Boolean(params.client.clientSecret)),
    fetcher,
    context: "Token refresh",
  });
}

export function computeTokenExpiresAt(expiresIn: number | null): string | null {
  if (expiresIn === null) {
    return null;
  }
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}
