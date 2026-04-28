import {
  fetchComposioConnections,
  initiateComposioConnect,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} from "@/lib/composio";
import {
  extractComposioConnections,
  normalizeComposioConnections,
  normalizeComposioToolkitSlug,
} from "@/lib/composio-client";
import { resolveComposioConnectToolkitSlug } from "@/lib/composio-normalization";
import { resolveAppPublicOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ConnectRequestBody = {
  toolkit?: unknown;
};

export async function POST(request: Request) {
  const apiKey = resolveComposioApiKey();
  if (!apiKey) {
    return Response.json(
      { error: "Dench Cloud API key is required." },
      { status: 403 },
    );
  }

  const eligibility = resolveComposioEligibility();
  if (!eligibility.eligible) {
    return Response.json(
      {
        error: "Dench Cloud must be the primary provider.",
        lockReason: eligibility.lockReason,
        lockBadge: eligibility.lockBadge,
      },
      { status: 403 },
    );
  }

  let body: ConnectRequestBody;
  try {
    body = (await request.json()) as ConnectRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.toolkit !== "string" || !body.toolkit.trim()) {
    return Response.json(
      { error: "Field 'toolkit' must be a non-empty string." },
      { status: 400 },
    );
  }

  const origin = resolveAppPublicOrigin(request);
  const callbackUrl = `${origin}/api/composio/callback`;
  const gatewayUrl = resolveComposioGatewayUrl();
  const requestedToolkit = body.toolkit.trim();
  const connectToolkit = resolveComposioConnectToolkitSlug(requestedToolkit);
  const normalizedToolkit = normalizeComposioToolkitSlug(connectToolkit);

  try {
    const activeConnection = normalizeComposioConnections(
      extractComposioConnections(await fetchComposioConnections(gatewayUrl, apiKey)),
    ).find((connection) => connection.normalized_toolkit_slug === normalizedToolkit && connection.is_active);

    if (activeConnection) {
      return Response.json(
        {
          error: "This app is already connected. Disconnect it before connecting another account.",
          code: "APP_ALREADY_CONNECTED",
          connection_id: activeConnection.id,
          toolkit: normalizedToolkit,
        },
        { status: 409 },
      );
    }

    const data = await initiateComposioConnect(
      gatewayUrl,
      apiKey,
      connectToolkit,
      callbackUrl,
    );
    return Response.json({
      ...data,
      requested_toolkit: requestedToolkit,
      connect_toolkit: connectToolkit,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to initiate connection." },
      { status: 502 },
    );
  }
}
