import { describe, expect, it, vi } from "vitest";
import { parseWwwAuthenticate, probeMcpServer } from "./mcp-probe";

describe("parseWwwAuthenticate", () => {
  it("returns null for missing or empty headers", () => {
    expect(parseWwwAuthenticate(null)).toBeNull();
    expect(parseWwwAuthenticate("")).toBeNull();
    expect(parseWwwAuthenticate("   ")).toBeNull();
  });

  it("returns null when no Bearer challenge is present", () => {
    expect(parseWwwAuthenticate("Basic realm=\"acme\"")).toBeNull();
  });

  it("parses a bare Bearer challenge", () => {
    const challenge = parseWwwAuthenticate("Bearer");
    expect(challenge).toEqual({
      scheme: "Bearer",
      realm: null,
      resourceMetadataUrl: null,
      scope: null,
      errorCode: null,
      errorDescription: null,
    });
  });

  it("parses RFC 9728 resource_metadata with all auxiliary fields", () => {
    const challenge = parseWwwAuthenticate(
      'Bearer realm="acme", resource_metadata="https://acme.com/.well-known/oauth-protected-resource", scope="mcp:read mcp:write", error="invalid_token", error_description="The access token expired"',
    );
    expect(challenge).toEqual({
      scheme: "Bearer",
      realm: "acme",
      resourceMetadataUrl: "https://acme.com/.well-known/oauth-protected-resource",
      scope: "mcp:read mcp:write",
      errorCode: "invalid_token",
      errorDescription: "The access token expired",
    });
  });

  it("handles values containing commas inside quotes", () => {
    const challenge = parseWwwAuthenticate(
      'Bearer error_description="Token expired, please refresh", scope="read"',
    );
    expect(challenge?.errorDescription).toBe("Token expired, please refresh");
    expect(challenge?.scope).toBe("read");
  });

  it("preserves embedded escaped quotes", () => {
    const challenge = parseWwwAuthenticate(
      'Bearer error_description="Quote inside: \\"value\\""',
    );
    expect(challenge?.errorDescription).toBe('Quote inside: "value"');
  });

  it("parses unquoted parameter values", () => {
    const challenge = parseWwwAuthenticate("Bearer error=invalid_token");
    expect(challenge?.errorCode).toBe("invalid_token");
  });
});

function makeFetchSpy(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(input, init));
}

describe("probeMcpServer", () => {
  const URL = "https://mcp.example.com";

  it("returns connected with tool count for a JSON tools/list response", async () => {
    const fetcher = makeFetchSpy(() =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "alpha" },
              { name: "beta" },
              { name: "gamma" },
            ],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const result = await probeMcpServer({ url: URL, fetcher });
    expect(result.status).toBe("connected");
    expect(result.toolCount).toBe(3);
    expect(result.detail).toMatch(/3 tools/);
    expect(result.authChallenge).toBeNull();
    expect(result.httpStatus).toBe(200);
  });

  it("counts tools in an SSE-framed response", async () => {
    const sseBody = [
      "event: message",
      "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"x\"},{\"name\":\"y\"}]}}",
      "",
      "data: [DONE]",
    ].join("\n");
    const fetcher = makeFetchSpy(() =>
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const result = await probeMcpServer({ url: URL, fetcher });
    expect(result.status).toBe("connected");
    expect(result.toolCount).toBe(2);
  });

  it("classifies 401 with WWW-Authenticate as needs_auth and surfaces the resource_metadata URL", async () => {
    const fetcher = makeFetchSpy(() =>
      new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://auth.example.com/.well-known/oauth-protected-resource", error="invalid_token"',
        },
      }),
    );

    const result = await probeMcpServer({ url: URL, fetcher });
    expect(result.status).toBe("needs_auth");
    expect(result.toolCount).toBeNull();
    expect(result.authChallenge?.resourceMetadataUrl).toBe(
      "https://auth.example.com/.well-known/oauth-protected-resource",
    );
    expect(result.authChallenge?.errorCode).toBe("invalid_token");
    expect(result.httpStatus).toBe(401);
  });

  it("returns needs_auth even when the 401 has no WWW-Authenticate header", async () => {
    const fetcher = makeFetchSpy(() => new Response("", { status: 401 }));
    const result = await probeMcpServer({ url: URL, fetcher });
    expect(result.status).toBe("needs_auth");
    expect(result.authChallenge).toBeNull();
  });

  it("classifies non-auth HTTP errors as error", async () => {
    const fetcher = makeFetchSpy(() =>
      new Response("Internal Server Error", { status: 500 }),
    );
    const result = await probeMcpServer({ url: URL, fetcher });
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/HTTP 500/);
    expect(result.httpStatus).toBe(500);
  });

  it("classifies a 200 with malformed JSON as error", async () => {
    const fetcher = makeFetchSpy(() =>
      new Response("not-json-at-all", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await probeMcpServer({ url: URL, fetcher });
    expect(result.status).toBe("error");
  });

  it("forwards extra request headers (used to send the Authorization header)", async () => {
    const fetcher = makeFetchSpy((_input, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      expect(headers.get("authorization")).toBe("Bearer abc");
      return new Response(
        JSON.stringify({ result: { tools: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await probeMcpServer({
      url: URL,
      headers: { Authorization: "Bearer abc" },
      fetcher,
    });
    expect(result.status).toBe("connected");
    expect(result.toolCount).toBe(0);
  });

  it("returns error when the fetcher throws", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    const result = await probeMcpServer({ url: URL, fetcher });
    expect(result.status).toBe("error");
    expect(result.detail).toContain("network unreachable");
    expect(result.httpStatus).toBeNull();
  });
});
