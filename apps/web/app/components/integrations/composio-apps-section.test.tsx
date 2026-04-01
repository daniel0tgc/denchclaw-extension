// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposioAppsSection } from "./composio-apps-section";

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
  items: [
    {
      id: "ca_gmail_1",
      toolkit_slug: "gmail",
      toolkit_name: "Gmail",
      status: "ACTIVE",
      created_at: "2026-04-01T00:00:00.000Z",
      account_label: "Work Gmail",
    },
    {
      id: "ca_gmail_2",
      toolkit_slug: "gmail",
      toolkit_name: "Gmail",
      status: "ACTIVE",
      created_at: "2026-04-02T00:00:00.000Z",
      account_label: "Personal Gmail",
    },
    {
      id: "ca_github_1",
      toolkit_slug: "github",
      toolkit_name: "GitHub",
      status: "ACTIVE",
      created_at: "2026-04-03T00:00:00.000Z",
      account_label: "GitHub",
    },
  ],
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
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  });

  it("shows unique connected app counts and multi-account card states", async () => {
    render(<ComposioAppsSection eligible lockBadge={null} />);

    await waitFor(() => {
      expect(screen.getByText("2 apps connected")).toBeInTheDocument();
    });

    const activeAccountsLabel = screen.getByText("active accounts");
    expect(activeAccountsLabel).toBeInTheDocument();
    expect(activeAccountsLabel.previousElementSibling?.textContent).toBe("3");
    expect(screen.getByRole("button", { name: "Manage Gmail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Notion" })).toBeInTheDocument();
    expect(screen.getByText("2 accounts connected")).toBeInTheDocument();
  });

  it("opens a toolkit modal with multi-account management details", async () => {
    const user = userEvent.setup();
    render(<ComposioAppsSection eligible lockBadge={null} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Manage Gmail" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Manage Gmail" }));

    expect(screen.getByRole("heading", { name: "Gmail" })).toBeInTheDocument();
    expect(screen.getByText("Existing connections")).toBeInTheDocument();
    expect(screen.getByText("Personal Gmail")).toBeInTheDocument();
    expect(screen.getByText("Work Gmail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect another account" })).toBeInTheDocument();
  });
});
