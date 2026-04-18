import {
  advanceOnboardingStep,
  readOnboardingState,
  writeOnboardingState,
} from "@/lib/denchclaw-state";
import { trackServer, writePersonInfo } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  const state = readOnboardingState();
  return Response.json(state.identity ?? null);
}

export async function POST(req: Request) {
  let body: { name?: unknown; email?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!name) {
    return Response.json({ error: "`name` is required." }, { status: 400 });
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ error: "`email` must be a valid address." }, { status: 400 });
  }

  // Mirror name/email into telemetry.json so PostHog identifies the user
  // properly going forward — this matches what the CLI bootstrap *would*
  // collect if it had an identity step.
  writePersonInfo({ name, email });

  const current = readOnboardingState();
  const identity = { name, email, capturedAt: new Date().toISOString() };
  if (current.currentStep === "identity") {
    const next = advanceOnboardingStep("identity", "dench-cloud", { identity });
    trackServer("onboarding_identity_captured", { has_email: true });
    return Response.json(next);
  }

  // User is editing identity from a later step — just save without advancing.
  const next = writeOnboardingState({ ...current, identity });
  return Response.json(next);
}
