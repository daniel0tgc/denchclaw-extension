import {
  getMcpServerConfig,
  McpServerError,
  recordServerState,
  setAuthorizationHeader,
} from "@/lib/mcp-servers";
import {
  computeTokenExpiresAt,
  discoverOAuthMetadata,
  refreshAccessToken,
  type RegisteredClient,
} from "@/lib/mcp-oauth";
import { probeMcpServer } from "@/lib/mcp-probe";
import { getMcpServerSecret, setMcpServerSecret } from "@/lib/mcp-secrets";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ProbeBody = {
  key?: unknown;
};

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function tryRefreshAfterInvalidToken(key: string): Promise<{
  refreshed: boolean;
  detail: string | null;
}> {
  const cached = getMcpServerSecret(key);
  if (!cached?.refreshToken || !cached.clientId || !cached.asMetadataUrl) {
    return { refreshed: false, detail: "No refresh token is available." };
  }

  try {
    const discovered = await discoverOAuthMetadata(cached.asMetadataUrl);
    const client: RegisteredClient = {
      clientId: cached.clientId,
      clientSecret: cached.clientSecret,
      registrationAccessToken: null,
      registrationClientUri: null,
    };
    const token = await refreshAccessToken({
      asMetadata: discovered.authServer,
      client,
      refreshToken: cached.refreshToken,
      scope: cached.scope,
      resource: discovered.resource.resource,
    });

    setAuthorizationHeader(key, `${token.tokenType} ${token.accessToken}`);
    setMcpServerSecret(key, {
      refreshToken: token.refreshToken ?? cached.refreshToken,
      tokenExpiresAt: computeTokenExpiresAt(token.expiresIn),
      scope: token.scope ?? cached.scope,
    });
    trackServer("mcp_probe_refreshed", { key, success: true });
    return { refreshed: true, detail: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Token refresh failed.";
    setMcpServerSecret(key, {
      refreshToken: null,
      tokenExpiresAt: null,
    });
    trackServer("mcp_probe_refreshed", {
      key,
      success: false,
      reason: detail,
    });
    return { refreshed: false, detail };
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: ProbeBody;
  try {
    body = (await req.json()) as ProbeBody;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (typeof body.key !== "string") {
    return jsonError("Field 'key' must be a string.", 400);
  }

  let serverConfig;
  try {
    serverConfig = getMcpServerConfig(body.key);
  } catch (err) {
    if (err instanceof McpServerError) {
      return jsonError(err.message, err.status);
    }
    return jsonError(
      err instanceof Error ? err.message : "Failed to load MCP server.",
      500,
    );
  }

  if (!serverConfig) {
    return jsonError(`MCP server '${body.key}' was not found.`, 404);
  }

  let result = await probeMcpServer({
    url: serverConfig.url,
    headers: serverConfig.headers,
  });

  const invalidToken = result.status === "needs_auth"
    && result.authChallenge?.errorCode === "invalid_token";

  if (invalidToken) {
    const refresh = await tryRefreshAfterInvalidToken(body.key);
    if (refresh.refreshed) {
      const refreshedConfig = getMcpServerConfig(body.key);
      if (refreshedConfig) {
        result = await probeMcpServer({
          url: refreshedConfig.url,
          headers: refreshedConfig.headers,
        });
      }
    } else {
      result = {
        ...result,
        detail: refresh.detail ?? result.detail,
      };
    }
  }

  try {
    const entry = recordServerState(body.key, {
      state: result.status,
      toolCount: result.toolCount,
      detail: result.detail,
      checkedAt: result.checkedAt,
    });
    return Response.json({
      server: entry,
      probe: {
        status: result.status,
        toolCount: result.toolCount,
        detail: result.detail,
        checkedAt: result.checkedAt,
        httpStatus: result.httpStatus,
        authChallenge: result.authChallenge,
      },
    });
  } catch (err) {
    if (err instanceof McpServerError) {
      return jsonError(err.message, err.status);
    }
    return jsonError(
      err instanceof Error ? err.message : "Failed to record probe result.",
      500,
    );
  }
}
