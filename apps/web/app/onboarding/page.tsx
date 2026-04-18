import { redirect } from "next/navigation";
import { readOnboardingState } from "@/lib/denchclaw-state";
import { OnboardingWizard } from "../components/onboarding/onboarding-wizard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function OnboardingPage() {
  const initialState = readOnboardingState();
  if (initialState.currentStep === "complete") {
    redirect("/");
  }
  return <OnboardingWizard initialState={initialState} />;
}
