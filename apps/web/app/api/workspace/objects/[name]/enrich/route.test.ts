import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workspace", () => ({
  duckdbQueryOnFile: vi.fn(),
  duckdbExecOnFile: vi.fn(),
  findDuckDBForObject: vi.fn(() => "/tmp/workspace.duckdb"),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegrationsState: vi.fn(() => ({
    denchCloud: {
      hasKey: true,
      isPrimaryProvider: true,
      primaryModel: "dench-cloud/gpt-5.4",
    },
    metadata: { schemaVersion: 1 },
    search: {
      builtIn: { enabled: true, denied: false, provider: null },
      effectiveOwner: "web_search",
    },
    managedPlugins: [],
    integrations: [{ id: "apollo", enabled: true }],
  })),
  resolveDenchGatewayCredentials: vi.fn(() => ({
    apiKey: "dc-key",
    gatewayUrl: "https://gateway.example.com",
  })),
}));

describe("workspace enrichment route", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    const { duckdbExecOnFile, duckdbQueryOnFile } = await import("@/lib/workspace");
    vi.mocked(duckdbExecOnFile).mockReset();
    vi.mocked(duckdbQueryOnFile).mockReset();
  });

  it("forwards requiredFields for people enrichment derived from the apollo path", async () => {
    const { duckdbQueryOnFile } = await import("@/lib/workspace");
    vi.mocked(duckdbQueryOnFile).mockImplementation((_dbFile: string, sql: string) => {
      if (sql.includes("SELECT id FROM objects WHERE name")) {
        return [{ id: "obj_1" }] as never;
      }
      if (sql.includes("SELECT id, name, type FROM fields")) {
        return [{ id: "input_1", name: "email", type: "email" }] as never;
      }
      if (sql.includes("SELECT id FROM fields WHERE id")) {
        return [{ id: "field_1" }] as never;
      }
      if (sql.includes("FROM entries e")) {
        return [{ entry_id: "entry_1", input_value: "jane@acme.com" }] as never;
      }
      if (sql.includes("COUNT(*) as cnt")) {
        return [{ cnt: 0 }] as never;
      }
      return [] as never;
    });

    global.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://gateway.example.com/v1/enrichment/people");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        email: "jane@acme.com",
        requiredFields: ["fullName"],
      });
      expect(body.mode).toBeUndefined();
      return new Response(JSON.stringify({ person: { name: "Jane Doe" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://localhost/api/workspace/objects/leads/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldId: "field_1",
          apolloPath: "person.name",
          category: "people",
          inputFieldName: "email",
          scope: 1,
        }),
      }),
      { params: Promise.resolve({ name: "leads" }) },
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("forwards LinkedIn people enrichment with gateway-compatible snake_case keys", async () => {
    const { duckdbQueryOnFile } = await import("@/lib/workspace");
    vi.mocked(duckdbQueryOnFile).mockImplementation((_dbFile: string, sql: string) => {
      if (sql.includes("SELECT id FROM objects WHERE name")) {
        return [{ id: "obj_1" }] as never;
      }
      if (sql.includes("SELECT id, name, type FROM fields")) {
        return [{ id: "input_1", name: "LinkedIn URL", type: "url" }] as never;
      }
      if (sql.includes("SELECT id FROM fields WHERE id")) {
        return [{ id: "field_1" }] as never;
      }
      if (sql.includes("FROM entries e")) {
        return [{ entry_id: "entry_1", input_value: "https://www.linkedin.com/in/markrachapoom" }] as never;
      }
      if (sql.includes("COUNT(*) as cnt")) {
        return [{ cnt: 0 }] as never;
      }
      return [] as never;
    });

    global.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        linkedin_url: "https://www.linkedin.com/in/markrachapoom",
        requiredFields: ["fullName"],
      });
      expect(body.mode).toBeUndefined();
      return new Response(JSON.stringify({ person: { name: "Mark Rachapoom" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://localhost/api/workspace/objects/leads/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldId: "field_1",
          apolloPath: "person.name",
          category: "people",
          inputFieldName: "LinkedIn URL",
          scope: 1,
        }),
      }),
      { params: Promise.resolve({ name: "leads" }) },
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("forwards requiredFields as a CSV query param for company enrichment", async () => {
    const { duckdbQueryOnFile } = await import("@/lib/workspace");
    vi.mocked(duckdbQueryOnFile).mockImplementation((_dbFile: string, sql: string) => {
      if (sql.includes("SELECT id FROM objects WHERE name")) {
        return [{ id: "obj_1" }] as never;
      }
      if (sql.includes("SELECT id, name, type FROM fields")) {
        return [{ id: "input_1", name: "website", type: "url" }] as never;
      }
      if (sql.includes("SELECT id FROM fields WHERE id")) {
        return [{ id: "field_1" }] as never;
      }
      if (sql.includes("FROM entries e")) {
        return [{ entry_id: "entry_1", input_value: "https://acme.com" }] as never;
      }
      if (sql.includes("COUNT(*) as cnt")) {
        return [{ cnt: 0 }] as never;
      }
      return [] as never;
    });

    global.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://gateway.example.com/v1/enrichment/company");
      expect(url.searchParams.get("domain")).toBe("acme.com");
      expect(url.searchParams.get("requiredFields")).toBe("name");
      expect(url.searchParams.get("mode")).toBeNull();
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ organization: { name: "Acme" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://localhost/api/workspace/objects/accounts/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldId: "field_1",
          apolloPath: "organization.name",
          category: "company",
          inputFieldName: "website",
          scope: 1,
        }),
      }),
      { params: Promise.resolve({ name: "accounts" }) },
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects non-integer numeric scope values", async () => {
    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://localhost/api/workspace/objects/leads/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldId: "field_1",
          apolloPath: "person.name",
          category: "people",
          inputFieldName: "email",
          scope: 1.5,
        }),
      }),
      { params: Promise.resolve({ name: "leads" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid scope.",
    });
  });

  it("skips unknown people identifiers instead of sending them as email", async () => {
    const { duckdbQueryOnFile } = await import("@/lib/workspace");
    vi.mocked(duckdbQueryOnFile).mockImplementation((_dbFile: string, sql: string) => {
      if (sql.includes("SELECT id FROM objects WHERE name")) {
        return [{ id: "obj_1" }] as never;
      }
      if (sql.includes("SELECT id, name, type FROM fields")) {
        return [{ id: "input_1", name: "email", type: "email" }] as never;
      }
      if (sql.includes("SELECT id FROM fields WHERE id")) {
        return [{ id: "field_1" }] as never;
      }
      if (sql.includes("FROM entries e")) {
        return [{ entry_id: "entry_1", input_value: "Jane Example" }] as never;
      }
      if (sql.includes("COUNT(*) as cnt")) {
        return [{ cnt: 0 }] as never;
      }
      return [] as never;
    });

    global.fetch = vi.fn(async () => {
      throw new Error("fetch should not be called for unsupported people identifiers");
    }) as typeof fetch;

    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://localhost/api/workspace/objects/leads/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldId: "field_1",
          apolloPath: "person.name",
          category: "people",
          inputFieldName: "email",
          scope: 1,
        }),
      }),
      { params: Promise.resolve({ name: "leads" }) },
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("surfaces gateway invalid_required_field errors in SSE error events", async () => {
    const { duckdbQueryOnFile } = await import("@/lib/workspace");
    vi.mocked(duckdbQueryOnFile).mockImplementation((_dbFile: string, sql: string) => {
      if (sql.includes("SELECT id FROM objects WHERE name")) {
        return [{ id: "obj_1" }] as never;
      }
      if (sql.includes("SELECT id, name, type FROM fields")) {
        return [{ id: "input_1", name: "email", type: "email" }] as never;
      }
      if (sql.includes("SELECT id FROM fields WHERE id")) {
        return [{ id: "field_1" }] as never;
      }
      if (sql.includes("FROM entries e")) {
        return [{ entry_id: "entry_1", input_value: "jane@acme.com" }] as never;
      }
      if (sql.includes("COUNT(*) as cnt")) {
        return [{ cnt: 0 }] as never;
      }
      return [] as never;
    });

    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_required_field",
            message: "Unknown required fields: foo",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;

    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://localhost/api/workspace/objects/leads/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldId: "field_1",
          apolloPath: "person.name",
          category: "people",
          inputFieldName: "email",
          scope: 1,
        }),
      }),
      { params: Promise.resolve({ name: "leads" }) },
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Unknown required fields: foo");
  });
});
