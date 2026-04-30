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

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

type CallRecord = { url: string; method: string; body: unknown };

function recordCall(input: RequestInfo | URL, init?: RequestInit): CallRecord {
  return {
    url: urlOf(input),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
  };
}

describe("McpServersSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("re-adding a deleted server through the inline form persists it again", async () => {
    const calls: CallRecord[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordCall(input, init);
      calls.push(call);
      const { url, method } = call;

      if (url === "/api/settings/mcp" && method === "GET") {
        return Response.json({ servers: [server()] });
      }
      if (url === "/api/settings/mcp/probe" && method === "POST") {
        return Response.json({ server: server("connected") });
      }
      if (url === "/api/settings/mcp" && method === "DELETE") {
        return Response.json({ key: "acme" });
      }
      if (url === "/api/settings/mcp" && method === "POST") {
        return Response.json({ server: server() }, { status: 201 });
      }
      // The inline form fires connect/start once the row lands. Pretend
      // OAuth isn't supported so the popup path doesn't run here —
      // covered by the dedicated OAuth test below.
      if (url === "/api/settings/mcp/connect/start" && method === "POST") {
        return Response.json({ supportsOAuth: false, reason: "no oauth metadata" });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const user = userEvent.setup();
    render(<McpServersSection />);

    // Initial load + auto-probe of the existing 'acme' row.
    await waitFor(() => {
      expect(
        calls.filter((c) => c.url === "/api/settings/mcp/probe" && c.method === "POST"),
      ).toHaveLength(1);
    });

    await user.click(await screen.findByRole("button", { name: "Remove acme" }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    });

    await user.click(await screen.findByRole("button", { name: /New MCP Server/i }));
    const keyInput = await screen.findByPlaceholderText("e.g. stripe");
    await user.type(keyInput, "acme");
    await user.type(
      await screen.findByPlaceholderText("https://mcp.example.com"),
      "https://mcp.example.com",
    );
    // Two buttons can match name "Connect" if a row's needs_auth Connect is
    // visible alongside the inline form's Connect; pick the one inside the
    // inline form (the row currently has no Connect — list is empty here).
    const connectButtons = await screen.findAllByRole("button", { name: "Connect" });
    await user.click(connectButtons[0]);

    // The re-add hits /api/settings/mcp with the user-entered key/url.
    await waitFor(() => {
      const reAdd = calls.find(
        (c) =>
          c.url === "/api/settings/mcp" &&
          c.method === "POST" &&
          (c.body as { key?: string })?.key === "acme",
      );
      expect(reAdd).toBeDefined();
    });
  });

  it("inline Connect saves the server and immediately starts the OAuth flow", async () => {
    const calls: CallRecord[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = recordCall(input, init);
      calls.push(call);
      const { url, method } = call;

      if (url === "/api/settings/mcp" && method === "GET") {
        return Response.json({ servers: [] });
      }
      if (url === "/api/settings/mcp" && method === "POST") {
        return Response.json(
          {
            server: {
              key: "stripe",
              url: "https://mcp.stripe.example.com",
              transport: "streamable-http",
              hasAuth: false,
              state: "needs_auth",
              toolCount: null,
              lastCheckedAt: null,
              lastDetail: null,
            },
          },
          { status: 201 },
        );
      }
      if (url === "/api/settings/mcp/probe" && method === "POST") {
        return Response.json({
          server: {
            key: "stripe",
            url: "https://mcp.stripe.example.com",
            transport: "streamable-http",
            hasAuth: false,
            state: "needs_auth",
            toolCount: null,
            lastCheckedAt: null,
            lastDetail: null,
          },
        });
      }
      if (url === "/api/settings/mcp/connect/start" && method === "POST") {
        return Response.json({
          supportsOAuth: true,
          authorizationUrl: "https://auth.stripe.example.com/authorize?x=1",
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const popupStub = {
      closed: false,
      close: vi.fn(),
    } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popupStub);

    const user = userEvent.setup();
    render(<McpServersSection />);

    // Wait for the empty-state inline row to mount.
    await screen.findByRole("button", { name: /New MCP Server/i });

    await user.click(screen.getByRole("button", { name: /New MCP Server/i }));
    await user.type(screen.getByPlaceholderText("e.g. stripe"), "stripe");
    await user.type(
      screen.getByPlaceholderText("https://mcp.example.com"),
      "https://mcp.stripe.example.com",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));

    // The save POST happens first.
    await waitFor(() => {
      expect(
        calls.find(
          (c) =>
            c.url === "/api/settings/mcp" &&
            c.method === "POST" &&
            (c.body as { key?: string })?.key === "stripe",
        ),
      ).toBeDefined();
    });

    // Then connect/start fires for the same key — this is the
    // single-click-add+connect contract the user requested.
    await waitFor(() => {
      expect(
        calls.find(
          (c) =>
            c.url === "/api/settings/mcp/connect/start" &&
            (c.body as { key?: string })?.key === "stripe",
        ),
      ).toBeDefined();
    });

    // OAuth popup actually opens with the URL the API returned.
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "https://auth.stripe.example.com/authorize?x=1",
        expect.stringContaining("mcp-connect-stripe"),
        expect.any(String),
      );
    });

    openSpy.mockRestore();
  });
});
