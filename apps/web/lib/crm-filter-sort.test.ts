import { describe, expect, it } from "vitest";
import {
  CrmFilterError,
  decodeFiltersToSql,
  decodePagination,
  decodeSortToSql,
  type CrmFilterField,
} from "./crm-filter-sort";
import type { FilterGroup, SortRule } from "./object-filters";

const FIELDS: ReadonlyArray<CrmFilterField> = [
  { name: "Full Name", column: "name", type: "text" },
  { name: "Email Address", column: "email", type: "email" },
  { name: "Strength Label", column: "strength_label", type: "enum" },
  { name: "Strength Score", column: "strength_score", type: "number" },
  { name: "Last Interaction At", column: "last_interaction_at", type: "date" },
];

function encode(group: FilterGroup): string {
  return Buffer.from(JSON.stringify(group), "utf-8").toString("base64");
}

function encodeSort(rules: SortRule[]): string {
  return Buffer.from(JSON.stringify(rules), "utf-8").toString("base64");
}

describe("decodeFiltersToSql", () => {
  it("returns 1=1 when nothing is provided", () => {
    expect(decodeFiltersToSql(null, FIELDS)).toBe("1=1");
  });

  it("compiles a text contains filter", () => {
    const sql = decodeFiltersToSql(
      encode({
        id: "root",
        conjunction: "and",
        rules: [{ id: "r1", field: "Full Name", operator: "contains", value: "Sarah" }],
      }),
      FIELDS,
    );
    expect(sql.toLowerCase()).toContain('lower(coalesce("name", \'\')) like \'%sarah%\'');
  });

  it("compiles a number range filter", () => {
    const sql = decodeFiltersToSql(
      encode({
        id: "root",
        conjunction: "and",
        rules: [
          { id: "r1", field: "Strength Score", operator: "gte", value: 100 },
          { id: "r2", field: "Strength Score", operator: "lt", value: 500 },
        ],
      }),
      FIELDS,
    );
    expect(sql).toContain('TRY_CAST("strength_score" AS DOUBLE) >= 100');
    expect(sql).toContain('TRY_CAST("strength_score" AS DOUBLE) < 500');
    expect(sql).toContain(" AND ");
  });

  it("compiles enum is_any_of with multiple values", () => {
    const sql = decodeFiltersToSql(
      encode({
        id: "root",
        conjunction: "and",
        rules: [
          {
            id: "r1",
            field: "Strength Label",
            operator: "is_any_of",
            value: ["Inner circle", "Strong"],
          },
        ],
      }),
      FIELDS,
    );
    expect(sql).toContain('"strength_label" IN (');
    expect(sql).toContain("'Inner circle'");
    expect(sql).toContain("'Strong'");
  });

  it("compiles a date 'after' filter", () => {
    const sql = decodeFiltersToSql(
      encode({
        id: "root",
        conjunction: "and",
        rules: [
          {
            id: "r1",
            field: "Last Interaction At",
            operator: "after",
            value: "2026-01-01",
          },
        ],
      }),
      FIELDS,
    );
    expect(sql).toContain('"last_interaction_at" > \'2026-01-01\'');
  });

  it("rejects unknown field names with CrmFilterError(400)", () => {
    expect(() =>
      decodeFiltersToSql(
        encode({
          id: "root",
          conjunction: "and",
          rules: [
            {
              id: "r1",
              field: "Definitely Not A Real Column",
              operator: "contains",
              value: "anything",
            },
          ],
        }),
        FIELDS,
      ),
    ).toThrow(CrmFilterError);
  });

  it("escapes single quotes in text values to prevent SQL injection", () => {
    const sql = decodeFiltersToSql(
      encode({
        id: "root",
        conjunction: "and",
        rules: [
          { id: "r1", field: "Full Name", operator: "contains", value: "O'Brien" },
        ],
      }),
      FIELDS,
    );
    // Single-quote-doubled inside the LIKE clause.
    expect(sql).toContain("o''brien");
    expect(sql).not.toMatch(/'O'Brien'/);
  });

  it("rejects malformed base64 with CrmFilterError", () => {
    expect(() => decodeFiltersToSql("\u0000not-base64-at-all\u0000", FIELDS)).toThrow(
      CrmFilterError,
    );
  });

  it("treats invalid JSON as a CrmFilterError", () => {
    const garbage = Buffer.from("not json", "utf-8").toString("base64");
    expect(() => decodeFiltersToSql(garbage, FIELDS)).toThrow(CrmFilterError);
  });

  it("supports OR conjunction at the group level", () => {
    const sql = decodeFiltersToSql(
      encode({
        id: "root",
        conjunction: "or",
        rules: [
          { id: "r1", field: "Full Name", operator: "contains", value: "sarah" },
          { id: "r2", field: "Email Address", operator: "contains", value: "@acme" },
        ],
      }),
      FIELDS,
    );
    expect(sql).toContain(" OR ");
    expect(sql).not.toContain(" AND ");
  });

  it("handles is_empty / is_not_empty as universal operators", () => {
    const empty = decodeFiltersToSql(
      encode({
        id: "root",
        conjunction: "and",
        rules: [{ id: "r1", field: "Full Name", operator: "is_empty" }],
      }),
      FIELDS,
    );
    expect(empty).toContain('"name" IS NULL');

    const notEmpty = decodeFiltersToSql(
      encode({
        id: "root",
        conjunction: "and",
        rules: [{ id: "r1", field: "Full Name", operator: "is_not_empty" }],
      }),
      FIELDS,
    );
    expect(notEmpty).toContain('"name" IS NOT NULL');
  });
});

describe("decodeSortToSql", () => {
  it("returns null for missing payload", () => {
    expect(decodeSortToSql(null, FIELDS)).toBeNull();
  });

  it("emits ORDER BY with proper casts for number columns", () => {
    const out = decodeSortToSql(
      encodeSort([{ field: "Strength Score", direction: "desc" }]),
      FIELDS,
    );
    expect(out).toContain('TRY_CAST("strength_score" AS DOUBLE) DESC');
    expect(out).toContain("NULLS LAST");
  });

  it("emits ORDER BY with TIMESTAMP cast for date columns", () => {
    const out = decodeSortToSql(
      encodeSort([{ field: "Last Interaction At", direction: "asc" }]),
      FIELDS,
    );
    expect(out).toContain('CAST("last_interaction_at" AS TIMESTAMP) ASC');
  });

  it("rejects unknown sort fields with CrmFilterError", () => {
    expect(() =>
      decodeSortToSql(encodeSort([{ field: "Bogus", direction: "desc" }]), FIELDS),
    ).toThrow(CrmFilterError);
  });

  it("supports multiple sort keys", () => {
    const out = decodeSortToSql(
      encodeSort([
        { field: "Strength Score", direction: "desc" },
        { field: "Full Name", direction: "asc" },
      ]),
      FIELDS,
    );
    const parts = out!.split(",").map((s) => s.trim());
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("strength_score");
    expect(parts[1]).toContain("name");
  });
});

describe("decodePagination", () => {
  it("falls back to defaults when nothing provided", () => {
    const out = decodePagination(null, null, { pageSize: 100, maxPageSize: 500 });
    expect(out).toEqual({ page: 1, pageSize: 100, offset: 0 });
  });

  it("clamps pageSize to the maximum", () => {
    const out = decodePagination("3", "9999", { pageSize: 100, maxPageSize: 500 });
    expect(out.pageSize).toBe(500);
    expect(out.page).toBe(3);
    expect(out.offset).toBe(1000);
  });

  it("never returns a page less than 1", () => {
    const out = decodePagination("0", "50", { pageSize: 100, maxPageSize: 500 });
    expect(out.page).toBe(1);
    expect(out.offset).toBe(0);
  });
});
