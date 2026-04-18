"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { PersonAvatar } from "./person-avatar";
import { ConnectionStrengthChip } from "./connection-strength-chip";
import { formatRelativeDate, formatAbsoluteDate } from "./format-relative-date";
import type { CrmField } from "./crm-table-shell";

/**
 * Row shape — keep in sync with /api/crm/people/route.ts response.
 */
export type PersonRow = {
  id: string;
  name: string | null;
  email: string | null;
  company_name: string | null;
  job_title: string | null;
  source: string | null;
  strength_score: number | null;
  strength_label: string;
  strength_color: string;
  last_interaction_at: string | null;
  avatar_url: string | null;
};

/**
 * Field defs consumed by ObjectFilterBar so users can filter by any
 * column. Names mirror the column headers below — the API decodes these
 * into projected SQL predicates.
 */
export const PEOPLE_FIELDS: ReadonlyArray<CrmField> = [
  { id: "fld_name", name: "Full Name", type: "text" },
  { id: "fld_email", name: "Email Address", type: "email" },
  { id: "fld_company", name: "Company", type: "text" },
  { id: "fld_title", name: "Job Title", type: "text" },
  {
    id: "fld_strength_label",
    name: "Strength Label",
    type: "enum",
    enum_values: ["Inner circle", "Strong", "Active", "Weak", "Cold"],
    enum_colors: ["#6366f1", "#22c55e", "#3b82f6", "#f59e0b", "#94a3b8"],
  },
  { id: "fld_strength_score", name: "Strength Score", type: "number" },
  { id: "fld_last_interaction_at", name: "Last Interaction At", type: "date" },
  {
    id: "fld_source",
    name: "Source",
    type: "enum",
    enum_values: ["Manual", "Gmail", "Calendar"],
    enum_colors: ["#94a3b8", "#ef4444", "#3b82f6"],
  },
];

/**
 * Build the People column defs. Returned from a function (not a const)
 * so React memoizes against the consumer's render scope without sharing
 * cell components across instances.
 */
export function buildPeopleColumns(): ColumnDef<PersonRow>[] {
  return [
    {
      id: "Full Name",
      accessorFn: (row) => row.name ?? row.email ?? "",
      header: "Name",
      size: 240,
      minSize: 160,
      enableSorting: true,
      cell: ({ row }) => {
        const person = row.original;
        const display = person.name?.trim() || person.email || "Unknown";
        return (
          <div className="flex items-center gap-2.5 min-w-0">
            <PersonAvatar
              src={person.avatar_url}
              name={display}
              seed={person.email ?? person.id}
              size="sm"
            />
            <div className="min-w-0 flex flex-col">
              <span
                className="truncate text-[13px] font-medium leading-tight"
                style={{ color: "var(--color-text)" }}
              >
                {display}
              </span>
              {person.job_title && (
                <span
                  className="truncate text-[11px] leading-tight"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {person.job_title}
                </span>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "Email Address",
      accessorFn: (row) => row.email ?? "",
      header: "Email",
      size: 240,
      minSize: 140,
      enableSorting: true,
      cell: ({ row }) => {
        const email = row.original.email;
        if (!email) {
          return <span style={{ color: "var(--color-text-muted)" }}>—</span>;
        }
        return (
          <a
            href={`mailto:${email}`}
            onClick={(e) => e.stopPropagation()}
            className="truncate text-[13px] hover:underline"
            style={{ color: "var(--color-text)" }}
            title={email}
          >
            {email}
          </a>
        );
      },
    },
    {
      id: "Company",
      accessorFn: (row) => row.company_name ?? "",
      header: "Company",
      size: 180,
      minSize: 120,
      enableSorting: true,
      cell: ({ row }) => {
        const value = row.original.company_name;
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
    {
      id: "Source",
      accessorFn: (row) => row.source ?? "",
      header: "Source",
      size: 100,
      minSize: 80,
      enableSorting: true,
      cell: ({ row }) => {
        const source = row.original.source;
        if (!source) {
          return <span style={{ color: "var(--color-text-muted)" }}>—</span>;
        }
        const color =
          source === "Gmail"
            ? "#ef4444"
            : source === "Calendar"
              ? "#3b82f6"
              : "#94a3b8";
        return (
          <span
            className="inline-flex items-center gap-1.5 text-[12px]"
            style={{ color: "var(--color-text-muted)" }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 99,
                background: color,
                flexShrink: 0,
              }}
            />
            {source}
          </span>
        );
      },
    },
  ];
}
