// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServersSection } from "./mcp-servers-section";

type MockServer = {
  key: string;
  url: string;
  transport: string;
  hasAuth: boolean;
  state: "untested" | "connected" | "needs_auth" | "error";
  toolCount: number | null;
  lastCheckedAt: string | null;
  lastDetail: string | null;
};

function server(state: MockServer["state"] = "untested"): MockServer {
  return {
    key: "acme",
    url: "https://mcp.example.com",
    transport: "streamable-http",
    hasAuth: state === "connected",
    state,
    toolCount: state === "connected" ? 2 : null,
    lastCheckedAt: state === "connected" ? "2026-04-29T00:00:00.000Z" : null,
    lastDetail: state === "connected" ? "Connected. 2 tools available." : null,
  };
}

describe("McpServersSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("auto-probes again when a deleted server key is re-added", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/settings/mcp" && method === "GET") {
        return Response.json({ servers: [server()] });
      }
      if (url === "/api/settings/mcp/probe" && method === "POST") {
        return Response.json({
          server: server("connected"),
          probe: {
            status: "connected",
            toolCount: 2,
            detail: "Connected. 2 tools available.",
            checkedAt: "2026-04-29T00:00:00.000Z",
            httpStatus: 200,
          },
        });
      }
      if (url === "/api/settings/mcp" && method === "DELETE") {
        return Response.json({ key: "acme" });
      }
      if (url === "/api/settings/mcp" && method === "POST") {
        return Response.json({ server: server() }, { status: 201 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const user = userEvent.setup();
    render(<McpServersSection />);

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").length).toBe(1);
    });

    await user.click(await screen.findByRole("button", { name: "Remove acme" }));
    await screen.findByText("No MCP servers yet");

    await user.click(screen.getByRole("button", { name: "Add MCP Server" }));
    await user.type(screen.getByPlaceholderText("e.g. acme-mcp"), "acme");
    await user.type(screen.getByPlaceholderText("https://mcp.example.com"), "https://mcp.example.com");
    await user.click(screen.getByRole("button", { name: "Add Server" }));

    await waitFor(() => {
      const probeCalls = fetchMock.mock.calls.filter(([input, init]) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return url === "/api/settings/mcp/probe" && init?.method === "POST";
      });
      expect(probeCalls).toHaveLength(2);
    });
  });
});
