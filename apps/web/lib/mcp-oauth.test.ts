import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizationUrl,
  deriveCodeChallenge,
  discoverOAuthMetadata,
  exchangeCodeForToken,
  registerOAuthClient,
  type AuthorizationServerMetadata,
} from "./mcp-oauth";

function makeFetcher(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return await handler(url, init ?? {});
  });
}

const authServerMetadata: AuthorizationServerMetadata = {
  issuer: "https://auth.example.com",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  registrationEndpoint: "https://auth.example.com/register",
  scopesSupported: ["mcp:read"],
  responseTypesSupported: ["code"],
  grantTypesSupported: ["authorization_code", "refresh_token"],
  codeChallengeMethodsSupported: ["S256"],
  tokenEndpointAuthMethodsSupported: ["none", "client_secret_post"],
};

describe("MCP OAuth utilities", () => {
  it("discovers protected-resource metadata and authorization-server metadata", async () => {
    const fetcher = makeFetcher((url) => {
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return new Response(JSON.stringify({
          resource: "https://mcp.example.com",
          authorization_servers: ["https://auth.example.com"],
          scopes_supported: ["mcp:read"],
          bearer_methods_supported: ["header"],
        }));
      }
      if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          scopes_supported: ["mcp:read"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }));
      }
      return new Response("not found", { status: 404 });
    });

    const result = await discoverOAuthMetadata(
      "https://mcp.example.com/.well-known/oauth-protected-resource",
      { fetcher },
    );

    expect(result.resource.resource).toBe("https://mcp.example.com");
    expect(result.authServer.authorizationEndpoint).toBe("https://auth.example.com/authorize");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back to OIDC metadata when oauth-authorization-server metadata is unavailable", async () => {
    const fetcher = makeFetcher((url) => {
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return new Response(JSON.stringify({
          authorization_servers: ["https://auth.example.com"],
        }));
      }
      if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return new Response("not found", { status: 404 });
      }
      if (url === "https://auth.example.com/.well-known/openid-configuration") {
        return new Response(JSON.stringify({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        }));
      }
      return new Response("not found", { status: 404 });
    });

    const result = await discoverOAuthMetadata(
      "https://mcp.example.com/.well-known/oauth-protected-resource",
      { fetcher },
    );

    expect(result.authServer.tokenEndpoint).toBe("https://auth.example.com/token");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("uses RFC 8414 path-aware metadata URLs for issuers with paths", async () => {
    const fetcher = makeFetcher((url) => {
      if (url === "https://mcp.stripe.com/.well-known/oauth-protected-resource") {
        return new Response(JSON.stringify({
          resource: "https://mcp.stripe.com",
          authorization_servers: ["https://access.stripe.com/mcp"],
        }));
      }
      if (url === "https://access.stripe.com/.well-known/oauth-authorization-server/mcp") {
        return new Response(JSON.stringify({
          issuer: "https://access.stripe.com/mcp",
          authorization_endpoint: "https://access.stripe.com/mcp/oauth2/authorize",
          token_endpoint: "https://access.stripe.com/mcp/oauth2/token",
          registration_endpoint: "https://access.stripe.com/mcp/oauth2/register",
          scopes_supported: ["mcp"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }));
      }
      return new Response("not found", { status: 404 });
    });

    const result = await discoverOAuthMetadata(
      "https://mcp.stripe.com/.well-known/oauth-protected-resource",
      { fetcher },
    );

    expect(result.authServer.issuer).toBe("https://access.stripe.com/mcp");
    expect(result.authServer.authorizationEndpoint).toBe(
      "https://access.stripe.com/mcp/oauth2/authorize",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("registers a dynamic client with redirect URI and scope", async () => {
    const fetcher = makeFetcher((_url, init) => {
      if (typeof init.body !== "string") {
        throw new Error("Expected JSON string body.");
      }
      const body = JSON.parse(init.body) as {
        redirect_uris: string[];
        scope: string;
      };
      expect(body.redirect_uris).toEqual(["http://localhost:3100/callback"]);
      expect(body.scope).toBe("mcp:read");
      return new Response(JSON.stringify({
        client_id: "client-123",
        client_secret: "secret-456",
      }));
    });

    const client = await registerOAuthClient({
      asMetadata: authServerMetadata,
      redirectUri: "http://localhost:3100/callback",
      clientName: "DenchClaw (acme)",
      scope: "mcp:read",
      fetcher,
    });

    expect(client).toMatchObject({
      clientId: "client-123",
      clientSecret: "secret-456",
    });
  });

  it("derives the RFC 7636 S256 challenge correctly", () => {
    expect(deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("builds an authorization URL with PKCE, state, scope, and resource", () => {
    const params = buildAuthorizationUrl({
      asMetadata: authServerMetadata,
      client: {
        clientId: "client-123",
        clientSecret: null,
        registrationAccessToken: null,
        registrationClientUri: null,
      },
      redirectUri: "http://localhost:3100/callback",
      codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      state: "state-123",
      scope: "mcp:read",
      resource: "https://mcp.example.com",
    });

    const url = new URL(params.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("code_challenge")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("scope")).toBe("mcp:read");
    expect(url.searchParams.get("resource")).toBe("https://mcp.example.com");
  });

  it("exchanges an authorization code for tokens using PKCE", async () => {
    const fetcher = makeFetcher((_url, init) => {
      const body = init.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("code-123");
      expect(body.get("code_verifier")).toBe("verifier-123");
      expect(body.get("client_id")).toBe("client-123");
      return new Response(JSON.stringify({
        access_token: "access-123",
        token_type: "Bearer",
        refresh_token: "refresh-123",
        expires_in: 3600,
      }));
    });

    const token = await exchangeCodeForToken({
      asMetadata: authServerMetadata,
      client: {
        clientId: "client-123",
        clientSecret: null,
        registrationAccessToken: null,
        registrationClientUri: null,
      },
      code: "code-123",
      codeVerifier: "verifier-123",
      redirectUri: "http://localhost:3100/callback",
      fetcher,
    });

    expect(token).toMatchObject({
      accessToken: "access-123",
      refreshToken: "refresh-123",
      expiresIn: 3600,
    });
  });
});
