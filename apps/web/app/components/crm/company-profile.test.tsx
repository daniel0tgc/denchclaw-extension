// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyProfile } from "./company-profile";

function buildCompanyResponse(id: string, name: string) {
  return {
    company: {
      id,
      name,
      domain: null,
      website: null,
      industry: null,
      type: null,
      source: null,
      strength_score: null,
      strength_label: "—",
      strength_color: "#999999",
      last_interaction_at: null,
      notes: null,
      created_at: null,
      updated_at: null,
    },
    people: [],
    threads: [],
    events: [],
    summary: {
      people_count: 0,
      thread_count: 0,
      event_count: 0,
      strongest_contact: null,
    },
  };
}

function mockFetchForCompany() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const match = url.match(/\/api\/crm\/companies\/([^/?]+)/);
      const id = match ? decodeURIComponent(match[1]) : "unknown";
      return Promise.resolve(
        new Response(JSON.stringify(buildCompanyResponse(id, `Company ${id}`)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
}

function getActiveTabLabel(): string | null {
  const tablist = screen.getByText("Overview").parentElement;
  if (!tablist) return null;
  for (const child of Array.from(tablist.children)) {
    if (!(child instanceof HTMLButtonElement)) continue;
    const border = child.style.borderBottom;
    if (border && border.includes("var(--color-text)")) {
      return child.textContent?.trim() ?? null;
    }
  }
  return null;
}

describe("CompanyProfile tab reset on entry change", () => {
  let fetchSpy: ReturnType<typeof mockFetchForCompany>;

  beforeEach(() => {
    fetchSpy = mockFetchForCompany();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("resets the active tab to Overview when switching from one company to another", async () => {
    // Regression: with the same React instance reused across `companyId`
    // changes, `localTab` used to leak the previously-selected tab into
    // the new company whenever the URL didn't carry an explicit
    // `profileTab`. Reset on prop change is now mandatory.
    const user = userEvent.setup();
    const { rerender } = render(<CompanyProfile companyId="acme" />);

    await waitFor(() => {
      expect(screen.getByText("Company acme")).toBeInTheDocument();
    });
    expect(getActiveTabLabel()).toBe("Overview");

    await user.click(screen.getByRole("button", { name: "Team" }));
    expect(getActiveTabLabel()).toBe("Team");

    rerender(<CompanyProfile companyId="globex" />);

    await waitFor(() => {
      expect(screen.getByText("Company globex")).toBeInTheDocument();
    });
    // Without the reset guard, Team would still be active here because
    // the React instance is reused and `localTab` survives the prop change.
    expect(getActiveTabLabel()).toBe("Overview");
  });

  it("respects an explicit activeTab prop on the new entry (URL-supplied profileTab still wins)", async () => {
    const { rerender } = render(<CompanyProfile companyId="acme" />);
    await waitFor(() => {
      expect(screen.getByText("Company acme")).toBeInTheDocument();
    });

    rerender(<CompanyProfile companyId="globex" activeTab="emails" />);
    await waitFor(() => {
      expect(screen.getByText("Company globex")).toBeInTheDocument();
    });
    expect(getActiveTabLabel()).toBe("Emails");
  });
});
