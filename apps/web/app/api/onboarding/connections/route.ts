import {
  ONBOARDING_STEPS,
  advanceOnboardingStep,
  readConnections,
  readOnboardingState,
  writeConnection,
  writeOnboardingState,
  type ConnectionRecord,
  type OnboardingStep,
} from "@/lib/denchclaw-state";
import {
  fetchComposioConnections,
  resolveComposioApiKey,
  resolveComposioGatewayUrl,
} from "@/lib/composio";
import {
  extractComposioConnections,
  normalizeComposioConnections,
} from "@/lib/composio-client";
import { normalizeComposioToolkitSlug } from "@/lib/composio-normalization";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_TOOLKITS = new Set<"gmail" | "calendar">(["gmail", "calendar"]);
const VALID_STEPS = new Set<OnboardingStep>(ONBOARDING_STEPS);

function isValidStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && VALID_STEPS.has(value as OnboardingStep);
}

function calendarSlugMatches(toolkitSlug: string): boolean {
  const normalized = normalizeComposioToolkitSlug(toolkitSlug);
  return normalized === "google-calendar" || normalized === "googlecalendar";
}

async function resolveAccountEmail(connectionId: string): Promise<string | null> {
  const apiKey = resolveComposioApiKey();
  if (!apiKey) {return null;}
  try {
    const connections = normalizeComposioConnections(
      extractComposioConnections(
        await fetchComposioConnections(resolveComposioGatewayUrl(), apiKey),
      ),
    );
    const match = connections.find((conn) => conn.id === connectionId);
    if (!match) {return null;}
    return (
      match.account_email ||
      match.account?.email ||
      match.account_label ||
      match.display_label ||
      null
    );
  } catch {
    return null;
  }
}

export async function GET() {
  return Response.json(readConnections());
}

type PostBody = {
  toolkit?: unknown;
  connectionId?: unknown;
  toolkitSlug?: unknown;
  accountEmail?: unknown;
  fromStep?: unknown;
  toStep?: unknown;
};

export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const toolkit = typeof body.toolkit === "string" ? body.toolkit.trim() : "";
  if (!VALID_TOOLKITS.has(toolkit as "gmail" | "calendar")) {
    return Response.json(
      { error: "`toolkit` must be `gmail` or `calendar`." },
      { status: 400 },
    );
  }
  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
  if (!connectionId) {
    return Response.json({ error: "`connectionId` is required." }, { status: 400 });
  }
  const toolkitSlug = typeof body.toolkitSlug === "string" ? body.toolkitSlug.trim() : "";

  // Defence-in-depth: callback might race ahead of expected toolkit (e.g. user
  // OAuthed Calendar from the Gmail step). Detect mismatch + reject.
  if (toolkit === "calendar" && toolkitSlug && !calendarSlugMatches(toolkitSlug)) {
    return Response.json(
      { error: `Connected ${toolkitSlug} but expected Google Calendar.` },
      { status: 400 },
    );
  }
  if (toolkit === "gmail" && toolkitSlug && normalizeComposioToolkitSlug(toolkitSlug) !== "gmail") {
    return Response.json(
      { error: `Connected ${toolkitSlug} but expected Gmail.` },
      { status: 400 },
    );
  }

  const explicitEmail = typeof body.accountEmail === "string" && body.accountEmail.trim()
    ? body.accountEmail.trim()
    : null;
  const accountEmail = explicitEmail ?? (await resolveAccountEmail(connectionId));

  const record: ConnectionRecord = {
    connectionId,
    toolkitSlug: toolkitSlug || (toolkit === "calendar" ? "google-calendar" : "gmail"),
    accountEmail: accountEmail ?? undefined,
    connectedAt: new Date().toISOString(),
  };

  writeConnection(toolkit as "gmail" | "calendar", record);
  trackServer("onboarding_toolkit_connected", { toolkit });

  // If the request bundles a step transition, do that atomically with the
  // connection write so a refresh doesn't strand the user mid-step.
  const fromStep = body.fromStep;
  const toStep = body.toStep;
  if (fromStep && toStep && isValidStep(fromStep) && isValidStep(toStep)) {
    const next = advanceOnboardingStep(fromStep, toStep, {
      connections: {
        ...readOnboardingState().connections,
        [toolkit]: record,
      },
    });
    return Response.json(next);
  }

  // Otherwise just persist the connection on the current state.
  const current = readOnboardingState();
  const next = writeOnboardingState({
    ...current,
    connections: {
      ...current.connections,
      [toolkit]: record,
    },
  });
  return Response.json(next);
}
