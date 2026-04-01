// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposioConnectModal } from "./composio-connect-modal";
import type { ComposioConnection, ComposioToolkit } from "@/lib/composio";

const toolkit: ComposioToolkit = {
  slug: "gmail",
  name: "Gmail",
  description: "Read your inbox",
  logo: null,
  categories: ["Email"],
  auth_schemes: ["oauth2"],
  tools_count: 3,
};

function renderModal(overrides?: {
  onConnectionChange?: () => void;
  connections?: ComposioConnection[];
}) {
  return render(
    <ComposioConnectModal
      toolkit={toolkit}
      connections={overrides?.connections ?? []}
      open
      onOpenChange={() => {}}
      onConnectionChange={overrides?.onConnectionChange ?? (() => {})}
    />,
  );
}

describe("ComposioConnectModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ redirect_url: "http://localhost:3100/connect" }))
    ) as typeof fetch;
  });

  it("renders existing accounts and connect-another-account actions", () => {
    renderModal({
      connections: [
        {
          id: "ca_1",
          toolkit_slug: "gmail",
          toolkit_name: "Gmail",
          status: "ACTIVE",
          created_at: "2026-04-01T00:00:00.000Z",
          account_label: "Work Gmail",
          account_stable_id: "cmpacct_gmail_work",
          account: {
            stableId: "cmpacct_gmail_work",
            confidence: "high",
            label: "Work Gmail",
          },
          reconnect: {
            claim: "same",
            confidence: "high",
            relatedConnectionIds: ["ca_2"],
          },
        },
        {
          id: "ca_2",
          toolkit_slug: "gmail",
          toolkit_name: "Gmail",
          status: "ACTIVE",
          created_at: "2026-04-02T00:00:00.000Z",
          account_label: "Personal Gmail",
          account_stable_id: "cmpacct_gmail_work",
          account: {
            stableId: "cmpacct_gmail_work",
            confidence: "high",
            label: "Personal Gmail",
          },
          reconnect: {
            claim: "same",
            confidence: "high",
            relatedConnectionIds: ["ca_1"],
          },
        },
      ],
    });

    expect(screen.getByText("2 connected accounts available to your AI agent.")).toBeInTheDocument();
    expect(screen.getByText("Existing connections")).toBeInTheDocument();
    expect(screen.getByText("Personal Gmail")).toBeInTheDocument();
    expect(screen.getByText("Work Gmail")).toBeInTheDocument();
    expect(screen.getAllByText("Same account reconnected")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Connect another account" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Disconnect" })).toHaveLength(2);
  });

  it("shows inferred identity when the gateway cannot verify a stable account id", () => {
    renderModal({
      connections: [
        {
          id: "ca_weak",
          toolkit_slug: "gmail",
          toolkit_name: "Gmail",
          status: "ACTIVE",
          created_at: "2026-04-01T00:00:00.000Z",
          account_label: "Fallback Gmail",
          account: {
            confidence: "low",
            label: "Fallback Gmail",
          },
        },
      ],
    });

    expect(screen.getByText("Identity inferred")).toBeInTheDocument();
  });

  it("stops waiting and refreshes connections after a trusted callback message", async () => {
    const user = userEvent.setup();
    const onConnectionChange = vi.fn();
    const popup = { closed: false, focus: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

    renderModal({ onConnectionChange });

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(screen.getByRole("button", { name: "Waiting for authorization..." })).toBeDisabled();

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: window.location.origin,
        data: {
          type: "composio-callback",
          status: "success",
          connected_account_id: "ca_123",
        },
      }));
    });

    await waitFor(() => {
      expect(onConnectionChange).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("ignores callback messages from a different origin", async () => {
    const user = userEvent.setup();
    const onConnectionChange = vi.fn();
    const popup = { closed: false, focus: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

    renderModal({ onConnectionChange });

    await user.click(screen.getByRole("button", { name: "Connect" }));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://evil.example",
        data: {
          type: "composio-callback",
          status: "success",
        },
      }));
    });

    expect(onConnectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Waiting for authorization..." })).toBeDisabled();
  });

  it("refreshes connections after the popup closes even if the callback message is missed", async () => {
    const user = userEvent.setup();
    const onConnectionChange = vi.fn();
    const popup = { closed: false, focus: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

    renderModal({ onConnectionChange });

    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
    });

    popup.closed = true;
    await waitFor(() => {
      expect(onConnectionChange).toHaveBeenCalledTimes(1);
    }, { timeout: 1500 });
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });
});
