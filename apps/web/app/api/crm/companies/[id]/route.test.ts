import { beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_OBJECT_IDS } from "@/lib/workspace-schema-migrations";
import { GET } from "./route";

const { loadCrmFieldMapsMock, safeQueryMock } = vi.hoisted(() => ({
  loadCrmFieldMapsMock: vi.fn(),
  safeQueryMock: vi.fn(),
}));

vi.mock("@/lib/crm-queries", () => ({
  buildEntryProjection: vi.fn((params: {
    objectId: string;
    aliasedFields: Array<{ name: string; alias: string }>;
    whereSql?: string;
  }) => {
    const aliases = params.aliasedFields
      .map(({ name, alias }) => `${name}:${alias}`)
      .join(",");
    return `projection object=${params.objectId} fields=${aliases} where=${params.whereSql ?? ""}`;
  }),
  buildLatestMessagePerThreadCte: vi.fn(() => null),
  hydratePeopleByIds: vi.fn(async () => new Map()),
  jsonArrayContains: (columnExpr: string, id: string) => {
    const safeId = id.replace(/'/g, "''").replace(/"/g, '""');
    return `${columnExpr} LIKE '%"${safeId}"%'`;
  },
  loadCrmFieldMaps: loadCrmFieldMapsMock,
  safeQuery: safeQueryMock,
  sqlString: (value: string) => `'${value.replace(/'/g, "''")}'`,
}));

const baseFieldMaps = {
  people: {
    "Full Name": "people_name",
    "Email Address": "people_email",
    Company: "people_company",
    "Job Title": "people_job_title",
    "Strength Score": "people_strength",
    "Last Interaction At": "people_last_interaction",
    "Avatar URL": "people_avatar",
  },
  company: {
    "Company Name": "company_name",
    Domain: "company_domain",
    Website: "company_website",
    Industry: "company_industry",
    Type: "company_type",
    Source: "company_source",
    "Strength Score": "company_strength",
    "Last Interaction At": "company_last_interaction",
    Notes: "company_notes",
  },
  email_thread: {},
  email_message: {},
  calendar_event: {},
  interaction: {},
};

describe("CRM company profile API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadCrmFieldMapsMock.mockResolvedValue(baseFieldMaps);
  });

  it("populates Team from the People.Company relation even when email domain does not match", async () => {
    let peopleSql = "";
    safeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`object=${ONBOARDING_OBJECT_IDS.company}`)) {
        return [{
          entry_id: "comp_plaid_012",
          name: "Plaid",
          domain: "plaid.com",
          website: "https://plaid.com",
          strength_score: "0",
        }];
      }
      if (sql.includes(`object=${ONBOARDING_OBJECT_IDS.people}`)) {
        peopleSql = sql;
        if (!sql.includes("sub.company_id = 'comp_plaid_012'")) {
          return [];
        }
        return [{
          entry_id: "ppl_zachperret_20",
          name: "Zach Perret",
          email: "zach@founder.example",
          company_id: "comp_plaid_012",
          job_title: "CEO",
          strength_score: "12",
          last_interaction_at: null,
          avatar_url: null,
        }];
      }
      return [];
    });

    const res = await GET(
      new Request("http://localhost/api/crm/companies/comp_plaid_012"),
      { params: Promise.resolve({ id: "comp_plaid_012" }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.people).toHaveLength(1);
    expect(json.people[0]).toMatchObject({
      id: "ppl_zachperret_20",
      name: "Zach Perret",
      email: "zach@founder.example",
      job_title: "CEO",
    });
    expect(json.summary.people_count).toBe(1);
    expect(json.summary.strongest_contact).toBe("Zach Perret");
    expect(peopleSql).toContain("Company:company_id");
    expect(peopleSql).toContain("sub.company_id = 'comp_plaid_012'");
    expect(peopleSql).toContain(`sub.company_id LIKE '%"comp_plaid_012"%'`);
  });

  it("normalizes URL-like company domains for the email-domain fallback", async () => {
    loadCrmFieldMapsMock.mockResolvedValue({
      ...baseFieldMaps,
      people: {
        ...baseFieldMaps.people,
        Company: undefined,
      },
    });
    safeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`object=${ONBOARDING_OBJECT_IDS.company}`)) {
        return [{
          entry_id: "comp_plaid_012",
          name: "Plaid",
          domain: "https://plaid.com/about",
          website: null,
          strength_score: "0",
        }];
      }
      if (sql.includes(`object=${ONBOARDING_OBJECT_IDS.people}`)) {
        if (!sql.includes("LOWER(SUBSTR(sub.email, INSTR(sub.email, '@') + 1)) = 'plaid.com'")) {
          return [];
        }
        return [{
          entry_id: "ppl_domain_match",
          name: "Domain Match",
          email: "person@plaid.com",
          job_title: "Operator",
          strength_score: null,
          last_interaction_at: null,
          avatar_url: null,
        }];
      }
      return [];
    });

    const res = await GET(
      new Request("http://localhost/api/crm/companies/comp_plaid_012"),
      { params: Promise.resolve({ id: "comp_plaid_012" }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.people).toHaveLength(1);
    expect(json.people[0]).toMatchObject({
      id: "ppl_domain_match",
      name: "Domain Match",
      email: "person@plaid.com",
    });
  });
});
