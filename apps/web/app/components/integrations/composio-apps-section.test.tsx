// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposioAppsSection } from "./composio-apps-section";
import { extractComposioToolkits } from "@/lib/composio-client";

const toolkitsPayload = {
  items: [
    {
      slug: "gmail",
      name: "Gmail",
      description: "Read and send email",
      logo: null,
      categories: ["Email"],
      auth_schemes: ["oauth2"],
      tools_count: 4,
    },
    {
      slug: "github",
      name: "GitHub",
      description: "Work with repositories",
      logo: null,
      categories: ["Developer tools"],
      auth_schemes: ["oauth2"],
      tools_count: 6,
    },
    {
      slug: "notion",
      name: "Notion",
      description: "Search docs and databases",
      logo: null,
      categories: ["Knowledge"],
      auth_schemes: ["oauth2"],
      tools_count: 3,
    },
  ],
  cursor: null,
  total: 3,
  categories: ["Email", "Developer tools", "Knowledge"],
};

const connectionsPayload = {
  connections: [
    {
      id: "ca_gmail_1",
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
        relatedConnectionIds: ["ca_gmail_2"],
      },
    },
    {
      id: "ca_gmail_2",
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
        relatedConnectionIds: ["ca_gmail_1"],
      },
    },
    {
      id: "ca_github_1",
      toolkit_slug: "github",
      toolkit_name: "GitHub",
      status: "ACTIVE",
      created_at: "2026-04-03T00:00:00.000Z",
      account_label: "GitHub",
      account_stable_id: "cmpacct_github",
      account: {
        stableId: "cmpacct_github",
        confidence: "high",
        label: "GitHub",
      },
    },
  ],
};

const statusPayload = {
  summary: {
    level: "healthy" as const,
    verified: true,
    message: "Composio MCP is healthy.",
  },
  config: {
    status: "pass" as const,
    detail: "Config OK.",
  },
  gatewayTools: {
    status: "pass" as const,
    detail: "OK.",
    toolCount: 24,
  },
  liveAgent: {
    status: "pass" as const,
    detail: "Agent verified.",
    evidence: [],
  },
};

describe("ComposioAppsSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/composio/toolkits") {
        return new Response(JSON.stringify(toolkitsPayload));
      }
      if (url === "/api/composio/connections") {
        return new Response(JSON.stringify(connectionsPayload));
      }
      if (url === "/api/composio/status") {
        return new Response(JSON.stringify(statusPayload));
      }
      if (url === "/api/composio/tool-index") {
        return new Response(JSON.stringify({ ok: true }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  });

  it("shows connected apps in the Connected tab and available apps in Marketplace", async () => {
    const user = userEvent.setup();
    render(<ComposioAppsSection eligible lockBadge={null} />);

    await waitFor(() => {
      expect(screen.getByText("Gmail")).toBeInTheDocument();
    });

    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Marketplace" }));

    await waitFor(() => {
      expect(screen.getByText("Notion")).toBeInTheDocument();
    });
  });

  it("opens a toolkit modal with multi-account management details", async () => {
    const user = userEvent.setup();
    render(<ComposioAppsSection eligible lockBadge={null} />);

    await waitFor(() => {
      expect(screen.getByText("Gmail")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Manage Gmail" }));

    expect(screen.getByRole("heading", { name: "Gmail" })).toBeInTheDocument();
    expect(screen.getByText("Connections")).toBeInTheDocument();
    expect(screen.getByText("Personal Gmail")).toBeInTheDocument();
    expect(screen.getByText("Work Gmail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect another account" })).toBeInTheDocument();
  });

  it("shows MCP repair bar when status is unhealthy", async () => {
    const warningStatus = {
      ...statusPayload,
      summary: {
        level: "warning" as const,
        verified: false,
        message: "MCP needs attention.",
      },
    };

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/composio/toolkits") return new Response(JSON.stringify(toolkitsPayload));
      if (url === "/api/composio/connections") return new Response(JSON.stringify(connectionsPayload));
      if (url === "/api/composio/status") return new Response(JSON.stringify(warningStatus));
      if (url === "/api/composio/tool-index") return new Response(JSON.stringify({ ok: true }));
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<ComposioAppsSection eligible lockBadge={null} />);

    await waitFor(() => {
      expect(screen.getByText("MCP needs attention.")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Repair" })).toBeInTheDocument();
  });

  it("normalizes toolkit payloads that omit categories", () => {
    const normalized = extractComposioToolkits({
      items: [
        {
          slug: "slack",
          name: "Slack",
          description: "Team chat",
          tools_count: 4,
        },
      ],
    });

    expect(normalized.items[0]).toEqual(
      expect.objectContaining({
        slug: "slack",
        name: "Slack",
        categories: [],
        auth_schemes: [],
      }),
    );
    expect(normalized.categories).toEqual([]);
  });

  it("shows lock badge when not eligible", () => {
    render(<ComposioAppsSection eligible={false} lockBadge="Get Dench Cloud API Key" />);

    expect(screen.getByText("Available with Dench Cloud")).toBeInTheDocument();
    expect(screen.getByText("Get Dench Cloud API Key")).toBeInTheDocument();
  });
});
