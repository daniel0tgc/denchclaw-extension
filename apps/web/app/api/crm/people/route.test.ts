import { describe, it, expect, vi, beforeEach } from "vitest";

// We mock the lib layer rather than the DuckDB CLI: the route is a thin
// orchestration layer over `loadCrmFieldMaps` + `safeQuery`, and a real
// DB hit would require a CLI/temp-dir setup that's overkill for the
// smoke check (filter pills, search, pagination, response shape).

vi.mock("@/lib/crm-queries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crm-queries")>("@/lib/crm-queries");
  return {
    ...actual,
    loadCrmFieldMaps: vi.fn(async () => ({
      people: {
        "Full Name": "fld_name",
        "Email Address": "fld_email",
        "Company": "fld_company",
        "Job Title": "fld_title",
        "Source": "fld_source",
        "Strength Score": "fld_score",
        "Last Interaction At": "fld_last",
        "Avatar URL": "fld_avatar",
      },
      company: {},
      email_thread: {},
      email_message: {},
      calendar_event: {},
      interaction: {},
    })),
    safeQuery: vi.fn(async () => []),
  };
});

vi.mock("@/lib/workspace-schema-migrations", () => ({
  ONBOARDING_OBJECT_IDS: {
    people: "seed_obj_people",
    company: "seed_obj_company",
    email_thread: "seed_obj_email_thread",
    email_message: "seed_obj_email_message",
    calendar_event: "seed_obj_calendar_event",
    interaction: "seed_obj_interaction",
  },
  fetchFieldIdMap: vi.fn(async () => ({})),
}));

describe("GET /api/crm/people", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty result with the right shape when DB is empty", async () => {
    const { GET } = await import("./route.js");
    const req = new Request("http://localhost/api/crm/people");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { people: unknown[]; total: number; filter: string };
    expect(body.people).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.filter).toBe("strongest");
  });

  it("hydrates strength labels for returned rows", async () => {
    const { safeQuery } = await import("@/lib/crm-queries");
    // Data + count are now returned in a single query via COUNT(*) OVER ()
    // projected as `_total` on every row.
    vi.mocked(safeQuery).mockImplementation(async () => {
      return [
        {
          entry_id: "p1",
          name: "Sarah Chen",
          email: "sarah@acme.com",
          company_name: "Acme",
          job_title: "VP",
          source: "Gmail",
          strength_score: "1500",
          last_interaction_at: "2026-04-15T12:00:00Z",
          avatar_url: null,
          _total: "2",
        },
        {
          entry_id: "p2",
          name: "Some Guy",
          email: "guy@cold.io",
          company_name: null,
          job_title: null,
          source: "Gmail",
          strength_score: "0",
          last_interaction_at: null,
          avatar_url: null,
          _total: "2",
        },
      ] as never[];
    });

    const { GET } = await import("./route.js");
    const req = new Request("http://localhost/api/crm/people?filter=strongest");
    const res = await GET(req);
    const body = (await res.json()) as {
      total: number;
      people: Array<{ id: string; strength_label: string; strength_color: string; name: string }>;
    };
    expect(body.total).toBe(2);
    expect(body.people).toHaveLength(2);
    expect(body.people[0].strength_label).toBe("Inner circle");
    expect(body.people[1].strength_label).toBe("Cold");
    expect(body.people[0].strength_color).toMatch(/^#/);
  });

  it("normalizes invalid filter values back to 'strongest'", async () => {
    const { GET } = await import("./route.js");
    const req = new Request("http://localhost/api/crm/people?filter=garbage");
    const res = await GET(req);
    const body = (await res.json()) as { filter: string };
    expect(body.filter).toBe("strongest");
  });

  it("clamps the limit to the max page size", async () => {
    const { safeQuery } = await import("@/lib/crm-queries");
    const observedSqls: string[] = [];
    vi.mocked(safeQuery).mockImplementation(async (sql: string) => {
      observedSqls.push(sql);
      return [] as never[];
    });
    const { GET } = await import("./route.js");
    await GET(new Request("http://localhost/api/crm/people?limit=99999"));
    const dataSql = observedSqls.find((s) => s.includes("LIMIT")) ?? "";
    expect(dataSql).toContain("LIMIT 500");
  });
});
