import { readOnboardingState } from "@/lib/denchclaw-state";
import { discoverWorkspaces, getActiveWorkspaceName } from "@/lib/workspace";
import { OnboardingWizard } from "../components/onboarding/onboarding-wizard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function OnboardingPage() {
  const initialState = readOnboardingState();
  // Don't hard-redirect on `complete` — the wizard itself renders the final
  // landing ("You're all set, {name}") with an explicit "Open workspace"
  // button rather than an auto-bounce.
  // Read workspace inventory server-side so the wizard renders the workspace
  // switcher without an initial loading flicker. The switcher itself only
  // appears when more than one workspace exists.
  const workspaces = discoverWorkspaces();
  const activeWorkspace = getActiveWorkspaceName();
  return (
    <OnboardingWizard
      initialState={initialState}
      workspaceCount={workspaces.length}
      activeWorkspace={activeWorkspace}
    />
  );
}
