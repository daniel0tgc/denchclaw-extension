"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { CompanyFavicon } from "./company-favicon";
import { ConnectionStrengthChip } from "./connection-strength-chip";
import { formatRelativeDate, formatAbsoluteDate } from "./format-relative-date";
import type { CrmField } from "./crm-table-shell";

/**
 * Row shape — keep in sync with /api/crm/companies/route.ts response.
 */
export type CompanyRow = {
  id: string;
  name: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  source: string | null;
  strength_score: number | null;
  strength_label: string;
  strength_color: string;
  last_interaction_at: string | null;
  people_count: number;
  strongest_contact: string | null;
};

export const COMPANIES_FIELDS: ReadonlyArray<CrmField> = [
  { id: "fld_company_name", name: "Company Name", type: "text" },
  { id: "fld_domain", name: "Domain", type: "text" },
  { id: "fld_industry", name: "Industry", type: "text" },
  {
    id: "fld_strength_label",
    name: "Strength Label",
    type: "enum",
    enum_values: ["Inner circle", "Strong", "Active", "Weak", "Cold"],
    enum_colors: ["#6366f1", "#22c55e", "#3b82f6", "#f59e0b", "#94a3b8"],
  },
  { id: "fld_strength_score", name: "Strength Score", type: "number" },
  { id: "fld_people_count", name: "People Count", type: "number" },
  { id: "fld_last_interaction_at", name: "Last Interaction At", type: "date" },
];

export function buildCompaniesColumns(): ColumnDef<CompanyRow>[] {
  return [
    {
      id: "Company Name",
      accessorFn: (row) => row.name ?? row.domain ?? "",
      header: "Company",
      size: 280,
      minSize: 180,
      enableSorting: true,
      cell: ({ row }) => {
        const company = row.original;
        const display = company.name?.trim() || company.domain || "Unknown";
        return (
          <div className="flex items-center gap-2.5 min-w-0">
            <CompanyFavicon domain={company.domain} name={company.name} size="sm" />
            <div className="min-w-0 flex flex-col">
              <span
                className="truncate text-[13px] font-medium leading-tight"
                style={{ color: "var(--color-text)" }}
              >
                {display}
              </span>
              {company.industry && (
                <span
                  className="truncate text-[11px] leading-tight"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {company.industry}
                </span>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "Domain",
      accessorFn: (row) => row.domain ?? "",
      header: "Domain",
      size: 200,
      minSize: 140,
      enableSorting: true,
      cell: ({ row }) => {
        const domain = row.original.domain;
        const website = row.original.website;
        if (!domain) {
          return <span style={{ color: "var(--color-text-muted)" }}>—</span>;
        }
        const href = website || `https://${domain}`;
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="truncate text-[13px] hover:underline"
            style={{ color: "var(--color-text)" }}
            title={domain}
          >
            {domain}
          </a>
        );
      },
    },
    {
      id: "People Count",
      accessorFn: (row) => row.people_count,
      header: "People",
      size: 90,
      minSize: 70,
      enableSorting: true,
      cell: ({ row }) => {
        const count = row.original.people_count;
        return (
          <span
            className="text-[13px] tabular-nums"
            style={{ color: count > 0 ? "var(--color-text)" : "var(--color-text-muted)" }}
          >
            {count > 0 ? count.toLocaleString() : "—"}
          </span>
        );
      },
    },
    {
      id: "Strongest Contact",
      accessorFn: (row) => row.strongest_contact ?? "",
      header: "Strongest contact",
      size: 200,
      minSize: 140,
      enableSorting: true,
      cell: ({ row }) => {
        const value = row.original.strongest_contact;
        return (
          <span
            className="truncate text-[13px]"
            style={{ color: value ? "var(--color-text)" : "var(--color-text-muted)" }}
          >
            {value ?? "—"}
          </span>
        );
      },
    },
    {
      id: "Strength Label",
      accessorFn: (row) => row.strength_label,
      header: "Strength",
      size: 130,
      minSize: 100,
      enableSorting: true,
      cell: ({ row }) => (
        <ConnectionStrengthChip score={row.original.strength_score} size="sm" />
      ),
    },
    {
      id: "Last Interaction At",
      accessorFn: (row) => row.last_interaction_at ?? "",
      header: "Last Contact",
      size: 130,
      minSize: 110,
      enableSorting: true,
      cell: ({ row }) => {
        const value = row.original.last_interaction_at;
        if (!value) {
          return <span style={{ color: "var(--color-text-muted)" }}>—</span>;
        }
        return (
          <span
            className="text-[13px] tabular-nums"
            style={{ color: "var(--color-text-muted)" }}
            title={formatAbsoluteDate(value)}
          >
            {formatRelativeDate(value)}
          </span>
        );
      },
    },
  ];
}
