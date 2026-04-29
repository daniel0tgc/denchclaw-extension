import {
  getMcpServerConfig,
  McpServerError,
  recordServerState,
  setAuthorizationHeader,
} from "@/lib/mcp-servers";
import { probeMcpServer } from "@/lib/mcp-probe";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ConnectTokenBody = {
  key?: unknown;
  authToken?: unknown;
};

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function formatBearerHeader(rawToken: string): string {
  const tokenWithoutPrefix = rawToken.replace(/^Bearer\s+/iu, "").trim();
  return `Bearer ${tokenWithoutPrefix}`;
}

export async function POST(req: Request): Promise<Response> {
  let body: ConnectTokenBody;
  try {
    body = (await req.json()) as ConnectTokenBody;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (typeof body.key !== "string") {
    return jsonError("Field 'key' must be a string.", 400);
  }
  if (typeof body.authToken !== "string" || !body.authToken.trim()) {
    return jsonError("Field 'authToken' must be a non-empty string.", 400);
  }

  const tokenHeader = formatBearerHeader(body.authToken);
  trackServer("mcp_connect_started", {
    key: body.key,
    method: "token",
  });

  try {
    setAuthorizationHeader(body.key, tokenHeader);
  } catch (err) {
    if (err instanceof McpServerError) {
      return jsonError(err.message, err.status);
    }
    return jsonError(
      err instanceof Error ? err.message : "Failed to update MCP server auth.",
      500,
    );
  }

  const serverConfig = getMcpServerConfig(body.key);
  if (!serverConfig) {
    return jsonError(`MCP server '${body.key}' was not found.`, 404);
  }

  // Re-probe with the new token so the row's state reflects reality. If the
  // token is wrong the row will land in `needs_auth` again and the UI can
  // surface the error message from the server.
  const result = await probeMcpServer({
    url: serverConfig.url,
    headers: serverConfig.headers,
  });

  let entry;
  try {
    entry = recordServerState(body.key, {
      state: result.status,
      toolCount: result.toolCount,
      detail: result.detail,
      checkedAt: result.checkedAt,
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

  trackServer("mcp_server_token_set", {
    key: body.key,
    probe_status: result.status,
  });
  trackServer(
    result.status === "connected" ? "mcp_connect_completed" : "mcp_connect_failed",
    {
      key: body.key,
      method: "token",
      ...(result.status === "connected" ? {} : { reason: result.status }),
    },
  );

  return Response.json({
    server: entry,
    probe: {
      status: result.status,
      toolCount: result.toolCount,
      detail: result.detail,
      checkedAt: result.checkedAt,
      httpStatus: result.httpStatus,
    },
  });
}
