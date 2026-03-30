import {
  type DenchIntegrationId,
  setExaIntegrationEnabled,
} from "@/lib/integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ToggleRequestBody = {
  enabled?: unknown;
};

function isSupportedIntegration(id: string): id is DenchIntegrationId {
  return id === "exa" || id === "apollo" || id === "elevenlabs";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isSupportedIntegration(id)) {
    return Response.json({ error: "Unknown integration." }, { status: 404 });
  }

  let body: ToggleRequestBody;
  try {
    body = (await request.json()) as ToggleRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return Response.json({ error: "Field 'enabled' must be a boolean." }, { status: 400 });
  }

  if (id !== "exa") {
    return Response.json({ error: `Integration '${id}' is not writable yet.` }, { status: 409 });
  }

  const result = setExaIntegrationEnabled(body.enabled);
  return Response.json({
    integration: id,
    changed: result.changed,
    ...result.state,
  });
}
