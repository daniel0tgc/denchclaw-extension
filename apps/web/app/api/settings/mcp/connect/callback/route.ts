import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";
import {
  getMcpServerConfig,
  recordServerState,
  setAuthorizationHeader,
} from "@/lib/mcp-servers";
import { probeMcpServer } from "@/lib/mcp-probe";
import {
  computeTokenExpiresAt,
  discoverOAuthMetadata,
  exchangeCodeForToken,
  McpOAuthError,
  type RegisteredClient,
} from "@/lib/mcp-oauth";
import {
  clearTransientOAuthFields,
  getMcpServerSecret,
  setMcpServerSecret,
  type McpServerSecret,
} from "@/lib/mcp-secrets";
import { resolveAppPublicOrigin } from "@/lib/public-origin";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CallbackOutcome =
  | { kind: "success"; serverKey: string }
  | { kind: "error"; serverKey: string | null; reason: string; description: string };

/**
 * Linear scan of the secrets sidecar to find the server whose pending
 * `oauthState` matches the `state` query param. The volume is small
 * (handful of MCP servers per user), so a sorted index isn't worth the
 * code.
 */
function findServerKeyByState(state: string): string | null {
  const path = join(resolveOpenClawStateDir(), ".mcp-secrets.json");
  if (!existsSync(path)) {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const [key, value] of Object.entries(parsed)) {
    const entry = value as { oauthState?: unknown } | null;
    if (entry && typeof entry.oauthState === "string" && entry.oauthState === state) {
      return key;
    }
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJsonForScript(value: unknown): string {
  // Embedding JSON in a <script> tag — escape `<` so a literal `</script>`
  // inside a string can't break out of the tag.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderResultPage(
  outcome: CallbackOutcome,
  targetOrigin: string,
): Response {
  const message = outcome.kind === "success"
    ? {
        source: "denchclaw.mcp.connect",
        type: "mcp-connected",
        serverKey: outcome.serverKey,
      }
    : {
        source: "denchclaw.mcp.connect",
        type: "mcp-connect-failed",
        serverKey: outcome.serverKey,
        reason: outcome.reason,
        description: outcome.description,
      };

  const heading = outcome.kind === "success"
    ? `Connected ${escapeHtml(outcome.serverKey)}`
    : "Connection failed";
  const body = outcome.kind === "success"
    ? "You can close this window."
    : escapeHtml(outcome.description);
  const accentColor = outcome.kind === "success" ? "#10b981" : "#ef4444";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${heading}</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: #0b0d12;
      color: #e7e9ee;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      max-width: 360px;
      padding: 32px;
      border-radius: 16px;
      background: #1a1d24;
      border: 1px solid #2a2e38;
      text-align: center;
    }
    .card h1 {
      margin: 0 0 8px;
      font-size: 18px;
      color: ${accentColor};
    }
    .card p {
      margin: 0;
      font-size: 13px;
      line-height: 1.6;
      color: #9aa1ad;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${body}</p>
  </div>
  <script>
    (function () {
      var msg = ${escapeJsonForScript(message)};
      try {
        if (window.opener) {
          window.opener.postMessage(msg, ${escapeJsonForScript(targetOrigin)});
        }
      } catch (err) {
        // ignore — opener might be cross-origin in unusual setups
      }
      setTimeout(function () { window.close(); }, 800);
    }());
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function persistTokens(
  serverKey: string,
  cached: McpServerSecret,
  tokenResponse: {
    accessToken: string;
    tokenType: string;
    refreshToken: string | null;
    expiresIn: number | null;
    scope: string | null;
  },
): Promise<void> {
  setAuthorizationHeader(serverKey, `${tokenResponse.tokenType} ${tokenResponse.accessToken}`);
  setMcpServerSecret(serverKey, {
    refreshToken: tokenResponse.refreshToken ?? cached.refreshToken,
    tokenExpiresAt: computeTokenExpiresAt(tokenResponse.expiresIn),
    scope: tokenResponse.scope ?? cached.scope,
  });
  clearTransientOAuthFields(serverKey);
}

export async function GET(request: Request): Promise<Response> {
  const targetOrigin = resolveAppPublicOrigin(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const oauthErrorDescription = url.searchParams.get("error_description");

  // The AS reported an error — surface it to the opener and bail.
  if (oauthError) {
    const serverKey = state ? findServerKeyByState(state) : null;
    if (serverKey) {
      recordServerState(serverKey, {
        state: "needs_auth",
        detail: oauthErrorDescription ?? oauthError,
      });
      clearTransientOAuthFields(serverKey);
      trackServer("mcp_connect_failed", {
        key: serverKey,
        reason: oauthError,
      });
    }
    return renderResultPage(
      {
        kind: "error",
        serverKey,
        reason: oauthError,
        description: oauthErrorDescription ?? oauthError,
      },
      targetOrigin,
    );
  }

  if (!code || !state) {
    return renderResultPage(
      {
        kind: "error",
        serverKey: null,
        reason: "missing_code_or_state",
        description: "The authorization server did not return a code and state.",
      },
      targetOrigin,
    );
  }

  const serverKey = findServerKeyByState(state);
  if (!serverKey) {
    return renderResultPage(
      {
        kind: "error",
        serverKey: null,
        reason: "unknown_state",
        description: "Unknown state value. The Connect flow may have timed out — try again.",
      },
      targetOrigin,
    );
  }

  const cached = getMcpServerSecret(serverKey);
  if (!cached || !cached.codeVerifier || !cached.redirectUri) {
    return renderResultPage(
      {
        kind: "error",
        serverKey,
        reason: "missing_pkce",
        description: "Could not find the PKCE verifier saved at /connect/start time.",
      },
      targetOrigin,
    );
  }

  // Re-discover the AS metadata from the cached metadata URL so we don't
  // have to persist the entire AuthorizationServerMetadata document.
  let discovered;
  try {
    discovered = await discoverOAuthMetadata(cached.asMetadataUrl);
  } catch (err) {
    const reason = err instanceof McpOAuthError ? err.reason : "discovery_failed";
    const description = err instanceof Error ? err.message : "Discovery failed.";
    recordServerState(serverKey, { state: "needs_auth", detail: description });
    trackServer("mcp_connect_failed", { key: serverKey, reason });
    return renderResultPage(
      { kind: "error", serverKey, reason, description },
      targetOrigin,
    );
  }

  const client: RegisteredClient = {
    clientId: cached.clientId,
    clientSecret: cached.clientSecret,
    registrationAccessToken: null,
    registrationClientUri: null,
  };

  let tokenResponse;
  try {
    tokenResponse = await exchangeCodeForToken({
      asMetadata: discovered.authServer,
      client,
      code,
      codeVerifier: cached.codeVerifier,
      redirectUri: cached.redirectUri,
      resource: discovered.resource.resource,
    });
  } catch (err) {
    const reason = err instanceof McpOAuthError ? err.reason : "token_exchange_failed";
    const description = err instanceof Error ? err.message : "Token exchange failed.";
    recordServerState(serverKey, { state: "needs_auth", detail: description });
    clearTransientOAuthFields(serverKey);
    trackServer("mcp_connect_failed", { key: serverKey, reason });
    return renderResultPage(
      { kind: "error", serverKey, reason, description },
      targetOrigin,
    );
  }

  await persistTokens(serverKey, cached, tokenResponse);

  // Probe with the new token so the row's state lands as `connected`
  // immediately — the user shouldn't have to refresh the page.
  const serverConfig = getMcpServerConfig(serverKey);
  if (serverConfig) {
    const probe = await probeMcpServer({
      url: serverConfig.url,
      headers: serverConfig.headers,
    });
    recordServerState(serverKey, {
      state: probe.status,
      toolCount: probe.toolCount,
      detail: probe.detail,
      checkedAt: probe.checkedAt,
    });
  }

  trackServer("mcp_connect_completed", { key: serverKey });

  return renderResultPage(
    { kind: "success", serverKey },
    targetOrigin,
  );
}
