// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposioChatAction } from "@/lib/composio-chat-actions";
import { ChatComposioModalHost } from "./chat-composio-modal-host";

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function mockSlackModalFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url === "/api/composio/connections?include_toolkits=1&fresh=1") {
      return new Response(JSON.stringify({ connections: [], toolkits: [] }));
    }
    if (url.startsWith("/api/composio/toolkits?")) {
      return new Response(JSON.stringify({
        items: [{
          slug: "slack",
          name: "Slack",
          description: "Messages and channels",
          logo: "https://gateway.example/slack.svg",
          categories: ["Communication"],
          auth_schemes: ["oauth2"],
          tools_count: 4,
        }],
      }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("ChatComposioModalHost", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the composio modal directly for assistant connect links", async () => {
    mockSlackModalFetch();

    const onFallbackToIntegrations = vi.fn();

    render(
      <ChatComposioModalHost
        request={{ action: "connect", toolkitSlug: "slack", toolkitName: "Slack" }}
        onFallbackToIntegrations={onFallbackToIntegrations}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Connect Slack" })).toBeInTheDocument();
    });
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(onFallbackToIntegrations).not.toHaveBeenCalled();
  });

  it("keeps reconnect actions on the direct-open modal path", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/api/composio/connections?include_toolkits=1&fresh=1") {
        return new Response(JSON.stringify({
          connections: [{
            id: "slack-1",
            toolkit_slug: "slack",
            toolkit_name: "Slack",
            status: "ACTIVE",
            created_at: "2026-04-01T00:00:00.000Z",
          }],
          toolkits: [{
            slug: "slack",
            connect_slug: "slack",
            name: "Slack",
            description: "Messages and channels",
            logo: null,
            categories: ["Communication"],
            auth_schemes: ["oauth2"],
            tools_count: 4,
          }],
        }));
      }
      if (url.startsWith("/api/composio/toolkits?")) {
        return new Response(JSON.stringify({
          items: [{
            slug: "slack",
            name: "Slack",
            description: "Messages and channels",
            logo: "https://gateway.example/slack.svg",
            categories: ["Communication"],
            auth_schemes: ["oauth2"],
            tools_count: 4,
          }],
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(
      <ChatComposioModalHost
        request={{ action: "reconnect", toolkitSlug: "slack", toolkitName: "Slack" }}
        onFallbackToIntegrations={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reconnect Slack" })).toBeInTheDocument();
    });
  });

  it("falls back to integrations when the assistant link has no toolkit slug", async () => {
    global.fetch = vi.fn() as typeof fetch;
    const onFallbackToIntegrations = vi.fn();

    render(
      <ChatComposioModalHost
        request={{ action: "connect", toolkitName: "Slack" }}
        onFallbackToIntegrations={onFallbackToIntegrations}
      />,
    );

    await waitFor(() => {
      expect(onFallbackToIntegrations).toHaveBeenCalledTimes(1);
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("consumes assistant connect requests so closed modals do not reopen on remount", async () => {
    mockSlackModalFetch();
    const user = userEvent.setup();

    function Harness() {
      const [mounted, setMounted] = useState(true);
      const [request, setRequest] = useState<ComposioChatAction | null>({
        action: "connect",
        toolkitSlug: "slack",
        toolkitName: "Slack",
      });

      return (
        <>
          <button type="button" onClick={() => setMounted((value) => !value)}>
            Toggle host
          </button>
          {mounted && (
            <ChatComposioModalHost
              request={request}
              onRequestHandled={() => setRequest(null)}
              onFallbackToIntegrations={() => {}}
            />
          )}
        </>
      );
    }

    render(<Harness />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Connect Slack" })).toBeInTheDocument();
    });

    await user.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Connect Slack" })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Toggle host" }));
    await user.click(screen.getByRole("button", { name: "Toggle host" }));

    expect(screen.queryByRole("button", { name: "Connect Slack" })).not.toBeInTheDocument();
  });
});
