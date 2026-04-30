// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@/lib/denchclaw-state";
import { SetupStep } from "./setup-step";

const baseState: OnboardingState = {
  version: 1,
  currentStep: "connect-gmail",
  completedSteps: ["welcome", "identity", "dench-cloud"],
  identity: {
    name: "Vedant",
    email: "vedant@example.com",
    capturedAt: "2026-04-29T18:45:14.895Z",
  },
  denchCloud: {
    source: "cli",
    skipped: false,
    configuredAt: "2026-04-29T18:45:15.517Z",
  },
  startedAt: "2026-04-29T18:45:14.580Z",
  updatedAt: "2026-04-29T18:45:15.517Z",
};

function Harness({ onAdvance }: { onAdvance: (state: OnboardingState) => void }) {
  const [state, setState] = useState(baseState);
  return (
    <SetupStep
      state={state}
      onAdvance={(next) => {
        setState(next);
        onAdvance(next);
      }}
      onRefresh={async () => {}}
      onStageChange={() => {}}
    />
  );
}

describe("SetupStep", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("adopts an existing active Gmail connection before asking the user to connect", async () => {
    const onAdvance = vi.fn();
    const nextState: OnboardingState = {
      ...baseState,
      currentStep: "connect-calendar",
      completedSteps: ["welcome", "identity", "dench-cloud", "connect-gmail"],
      connections: {
        gmail: {
          connectionId: "ca_existing_gmail",
          toolkitSlug: "gmail",
          accountEmail: "person@example.com",
          connectedAt: "2026-04-30T00:00:00.000Z",
        },
      },
    };
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url === "/api/onboarding/dench-cloud") {
        return new Response(JSON.stringify({
          configured: true,
          source: "cli",
          primaryModel: "dench-cloud/gpt-5.5",
        }));
      }
      if (url === "/api/composio/connections?include_toolkits=1&fresh=1") {
        return new Response(JSON.stringify({
          connections: [
            {
              id: "ca_existing_gmail",
              toolkit_slug: "gmail",
              toolkit_name: "Gmail",
              status: "ACTIVE",
              account_email: "person@example.com",
              created_at: "2026-04-30T00:00:00.000Z",
            },
          ],
        }));
      }
      if (url === "/api/onboarding/connections") {
        if (typeof init?.body !== "string") {
          throw new Error("Expected string JSON body.");
        }
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify(nextState));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    render(<Harness onAdvance={onAdvance} />);

    await waitFor(() => {
      expect(onAdvance).toHaveBeenCalledWith(nextState);
    });
    expect(bodies).toEqual([
      {
        toolkit: "gmail",
        connectionId: "ca_existing_gmail",
        toolkitSlug: "gmail",
        accountEmail: "person@example.com",
        fromStep: "connect-gmail",
        toStep: "connect-calendar",
      },
    ]);
    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
  });
});
