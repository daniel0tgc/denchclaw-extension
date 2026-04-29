import {
  addMcpServer,
  getMcpServerConfig,
  listMcpServers,
  McpServerError,
  recordServerState,
  removeMcpServer,
} from "@/lib/mcp-servers";
import { probeMcpServer } from "@/lib/mcp-probe";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PostBody = {
  key?: unknown;
  url?: unknown;
  transport?: unknown;
};

type DeleteBody = {
  key?: unknown;
};

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function GET(): Promise<Response> {
  try {
    return Response.json({
      servers: listMcpServers(),
    });
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : "Failed to load MCP servers.",
      500,
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (typeof body.key !== "string") {
    return jsonError("Field 'key' must be a string.", 400);
  }
  if (typeof body.url !== "string") {
    return jsonError("Field 'url' must be a string.", 400);
  }
  if (body.transport !== undefined && typeof body.transport !== "string") {
    return jsonError("Field 'transport' must be a string.", 400);
  }

  let server;
  try {
    server = addMcpServer({
      key: body.key,
      url: body.url,
      transport: body.transport,
      // No authToken at creation time — Connect happens after the row appears,
      // either via the OAuth flow (Phase 2) or a paste-a-token dialog (Phase 1
      // fallback). This matches the Cursor UX where the Add dialog only takes
      // a name + URL.
    });
    trackServer("mcp_server_added", {
      key: server.key,
      transport: server.transport,
      has_auth: server.hasAuth,
    });
  } catch (err) {
    if (err instanceof McpServerError) {
      return jsonError(err.message, err.status);
    }
    return jsonError(
      err instanceof Error ? err.message : "Failed to add MCP server.",
      500,
    );
  }

  // Run an immediate probe so the new row lands with the right state. We
  // intentionally don't fail the POST when the probe fails — the row exists,
  // the user can click Connect to fix it. The probe just decides whether the
  // initial label says "Connect", "Needs authentication", or shows a tool
  // count.
  const serverConfig = getMcpServerConfig(server.key);
  if (serverConfig) {
    const probe = await probeMcpServer({
      url: serverConfig.url,
      headers: serverConfig.headers,
    });
    try {
      const updated = recordServerState(server.key, {
        state: probe.status,
        toolCount: probe.toolCount,
        detail: probe.detail,
        checkedAt: probe.checkedAt,
      });
      return Response.json({ server: updated }, { status: 201 });
    } catch {
      // If state recording fails for some reason, fall through to returning
      // the untested entry. The UI can re-probe.
    }
  }

  return Response.json({ server }, { status: 201 });
}

export async function DELETE(req: Request): Promise<Response> {
  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (typeof body.key !== "string") {
    return jsonError("Field 'key' must be a string.", 400);
  }

  try {
    removeMcpServer(body.key);
    trackServer("mcp_server_removed", { key: body.key });
    return Response.json({ key: body.key });
  } catch (err) {
    if (err instanceof McpServerError) {
      return jsonError(err.message, err.status);
    }
    return jsonError(
      err instanceof Error ? err.message : "Failed to remove MCP server.",
      500,
    );
  }
}
