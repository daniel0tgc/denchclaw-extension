import { redirect } from "next/navigation";
import { readOnboardingState } from "@/lib/denchclaw-state";
import { discoverWorkspaces, getActiveWorkspaceName } from "@/lib/workspace";
import { OnboardingWizard } from "../components/onboarding/onboarding-wizard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function OnboardingPage() {
  const initialState = readOnboardingState();
  if (initialState.currentStep === "complete") {
    redirect("/");
  }
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
