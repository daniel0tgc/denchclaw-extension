"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { CompanyFavicon } from "./company-favicon";
import { PersonAvatar } from "./person-avatar";
import { ConnectionStrengthChip } from "./connection-strength-chip";
import { CrmEmptyState, CrmLoadingState } from "./crm-list-shell";
import { formatAbsoluteDate, formatDayLabel, formatRelativeDate } from "./format-relative-date";
import { EnrichButton } from "./enrich-button";

// ---------------------------------------------------------------------------
// API response shape (mirrors apps/web/app/api/crm/companies/[id]/route.ts)
// ---------------------------------------------------------------------------

type CompanyResponse = {
  company: {
    id: string;
    name: string | null;
    domain: string | null;
    website: string | null;
    industry: string | null;
    type: string | null;
    source: string | null;
    strength_score: number | null;
    strength_label: string;
    strength_color: string;
    last_interaction_at: string | null;
    notes: string | null;
    created_at: string | null;
    updated_at: string | null;
  };
  people: Array<{
    id: string;
    name: string | null;
    email: string | null;
    job_title: string | null;
    strength_score: number | null;
    strength_label: string;
    strength_color: string;
    last_interaction_at: string | null;
    avatar_url: string | null;
  }>;
  threads: Array<{
    id: string;
    subject: string | null;
    last_message_at: string | null;
    message_count: number | null;
    gmail_thread_id: string | null;
  }>;
  events: Array<{
    id: string;
    title: string | null;
    start_at: string | null;
    end_at: string | null;
    meeting_type: string | null;
  }>;
  summary: {
    people_count: number;
    thread_count: number;
    event_count: number;
    strongest_contact: string | null;
  };
};

type Tab = "overview" | "team" | "emails" | "meetings";

const TABS: ReadonlyArray<{ id: Tab; label: string; count: (d: CompanyResponse) => number | null }> = [
  { id: "overview", label: "Overview", count: () => null },
  { id: "team", label: "Team", count: (d) => d.summary.people_count },
  { id: "emails", label: "Emails", count: (d) => d.summary.thread_count },
  { id: "meetings", label: "Meetings", count: (d) => d.summary.event_count },
];

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export function CompanyProfile({
  companyId,
  onOpenPerson,
  onOpenCompany: _onOpenCompany,
  onBackToList,
}: {
  companyId: string;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
  onBackToList?: () => void;
}) {
  void _onOpenCompany;
  const [data, setData] = useState<CompanyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/crm/companies/${encodeURIComponent(companyId)}`, {
        cache: "no-store",
      });
      if (res.status === 404) {
        setError("Company not found.");
        setData(null);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as CompanyResponse;
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load company.");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="flex h-full flex-col" style={{ background: "var(--color-background)" }}>
        <CrmLoadingState label="Loading company…" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex h-full flex-col" style={{ background: "var(--color-background)" }}>
        <CrmEmptyState
          title="Couldn't load this company"
          description={error ?? "The record may have been deleted."}
          cta={
            onBackToList && (
              <Button variant="outline" size="sm" onClick={onBackToList}>
                Back to Companies
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-background)" }}>
      <CompanyHeader data={data} tab={tab} onTabChange={setTab} onBackToList={onBackToList} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          {tab === "overview" && <OverviewTab data={data} />}
          {tab === "team" && <TeamTab data={data} onOpenPerson={onOpenPerson} />}
          {tab === "emails" && <EmailsTab data={data} />}
          {tab === "meetings" && <MeetingsTab data={data} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function CompanyHeader({
  data,
  tab,
  onTabChange,
  onBackToList,
}: {
  data: CompanyResponse;
  tab: Tab;
  onTabChange: (t: Tab) => void;
  onBackToList?: () => void;
}) {
  const { company } = data;
  const displayName = company.name?.trim() || company.domain || "Unknown company";
  return (
    <header
      className="shrink-0 px-6 pt-4 pb-0"
      style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-background)" }}
    >
      <div className="mb-3 flex items-center gap-2 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
        {onBackToList && (
          <button type="button" onClick={onBackToList} className="inline-flex items-center gap-1 hover:underline">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Companies
          </button>
        )}
      </div>
      <div className="flex items-start gap-4">
        <CompanyFavicon domain={company.domain} name={company.name} size="xl" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="font-instrument text-3xl tracking-tight truncate" style={{ color: "var(--color-text)" }}>
              {displayName}
            </h1>
            <ConnectionStrengthChip score={company.strength_score} />
          </div>
          <div
            className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {company.website && (
              <a href={company.website} target="_blank" rel="noreferrer" className="hover:underline">
                {company.website.replace(/^https?:\/\//, "")}
              </a>
            )}
            {company.industry && <span>{company.industry}</span>}
            {company.type && <span>{company.type}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <EnrichButton type="company" id={company.id} />
        </div>
      </div>
      <div className="mt-5 flex items-center gap-4 -mb-px">
        {TABS.map((t) => {
          const count = t.count(data);
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTabChange(t.id)}
              className="relative flex items-center gap-1.5 px-1 py-2 text-[13px] font-medium transition-colors"
              style={{
                color: active ? "var(--color-text)" : "var(--color-text-muted)",
                borderBottom: active ? "2px solid var(--color-text)" : "2px solid transparent",
              }}
            >
              {t.label}
              {typeof count === "number" && count > 0 && (
                <span
                  className="rounded-full px-1.5 py-0 text-[10px]"
                  style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function OverviewTab({ data }: { data: CompanyResponse }) {
  const { company, summary } = data;
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>
          At a glance
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="People" value={summary.people_count.toLocaleString()} />
          <Stat label="Threads" value={summary.thread_count.toLocaleString()} />
          <Stat label="Meetings" value={summary.event_count.toLocaleString()} />
          <Stat label="Strength" value={company.strength_label} />
        </div>
      </section>
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>
          Details
        </h3>
        <div
          className="space-y-2.5 rounded-2xl border p-4"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          <Field label="Domain" value={company.domain} />
          <Field
            label="Website"
            value={company.website ? company.website.replace(/^https?:\/\//, "") : null}
            link={company.website ?? undefined}
            external
          />
          <Field label="Industry" value={company.industry} />
          <Field label="Type" value={company.type} />
          <Field label="Source" value={company.source} />
          <Field
            label="Last contact"
            value={company.last_interaction_at ? formatRelativeDate(company.last_interaction_at) : null}
          />
        </div>
      </section>
      {summary.strongest_contact && (
        <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          Strongest contact: <strong style={{ color: "var(--color-text)" }}>{summary.strongest_contact}</strong>
        </p>
      )}
    </div>
  );
}

function TeamTab({
  data,
  onOpenPerson,
}: {
  data: CompanyResponse;
  onOpenPerson?: (id: string) => void;
}) {
  if (data.people.length === 0) {
    return <CrmEmptyState title="No people at this company yet" />;
  }
  return (
    <ul className="divide-y" style={{ borderTop: "1px solid var(--color-border)", borderBottom: "1px solid var(--color-border)" }}>
      {data.people.map((person) => {
        const displayName = person.name?.trim() || person.email || "Unknown";
        return (
          <li key={person.id}>
            <button
              type="button"
              onClick={() => onOpenPerson?.(person.id)}
              disabled={!onOpenPerson}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-surface-hover)] disabled:cursor-default"
            >
              <PersonAvatar src={person.avatar_url} name={displayName} seed={person.email ?? person.id} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium" style={{ color: "var(--color-text)" }}>
                  {displayName}
                </p>
                <p className="mt-0.5 truncate text-[12px]" style={{ color: "var(--color-text-muted)" }}>
                  {[person.job_title, person.email].filter(Boolean).join(" · ")}
                </p>
              </div>
              <ConnectionStrengthChip score={person.strength_score} size="sm" showLabel={false} />
              <span
                className="text-right text-[11px] shrink-0 w-16"
                style={{ color: "var(--color-text-muted)" }}
              >
                {person.last_interaction_at ? formatRelativeDate(person.last_interaction_at) : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EmailsTab({ data }: { data: CompanyResponse }) {
  if (data.threads.length === 0) {
    return <CrmEmptyState title="No threads yet" />;
  }
  return (
    <ul className="divide-y" style={{ borderTop: "1px solid var(--color-border)", borderBottom: "1px solid var(--color-border)" }}>
      {data.threads.map((thread) => {
        const linkHref = thread.gmail_thread_id
          ? `https://mail.google.com/mail/u/0/#all/${thread.gmail_thread_id}`
          : undefined;
        const Inner = (
          <div className="flex items-start gap-4 px-4 py-3 hover:bg-[var(--color-surface-hover)]">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium" style={{ color: "var(--color-text)" }}>
                {thread.subject?.trim() || "(no subject)"}
              </p>
              <p className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
                {thread.message_count ?? 0}{" "}
                {(thread.message_count ?? 0) === 1 ? "message" : "messages"}
              </p>
            </div>
            <span className="text-right text-[12px] shrink-0" style={{ color: "var(--color-text-muted)" }}>
              {thread.last_message_at && (
                <span title={formatAbsoluteDate(thread.last_message_at)}>
                  {formatRelativeDate(thread.last_message_at)}
                </span>
              )}
            </span>
          </div>
        );
        return (
          <li key={thread.id}>
            {linkHref ? (
              <a href={linkHref} target="_blank" rel="noreferrer" className="block">
                {Inner}
              </a>
            ) : (
              Inner
            )}
          </li>
        );
      })}
    </ul>
  );
}

function MeetingsTab({ data }: { data: CompanyResponse }) {
  if (data.events.length === 0) {
    return <CrmEmptyState title="No meetings with this company yet" />;
  }
  const groups = new Map<string, typeof data.events>();
  for (const event of data.events) {
    const day = event.start_at ? formatDayLabel(event.start_at) : "Unknown date";
    if (!groups.has(day)) {groups.set(day, []);}
    groups.get(day)!.push(event);
  }
  return (
    <div className="space-y-6">
      {Array.from(groups.entries()).map(([day, events]) => (
        <section key={day}>
          <h3
            className="sticky top-0 z-10 mb-2 px-1 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]"
            style={{ color: "var(--color-text-muted)", background: "var(--color-background)" }}
          >
            {day}
          </h3>
          <ul className="space-y-2">
            {events.map((event) => (
              <li
                key={event.id}
                className="rounded-xl border px-4 py-3"
                style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[14px] font-medium truncate" style={{ color: "var(--color-text)" }}>
                    {event.title?.trim() || "(no title)"}
                  </p>
                  {event.meeting_type && (
                    <span
                      className="text-[11px] rounded-full px-2 py-0.5"
                      style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                    >
                      {event.meeting_type}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
                  {event.start_at && formatAbsoluteDate(event.start_at)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      className="rounded-2xl border p-3"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <dt className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>
        {label}
      </dt>
      <dd className="mt-1 text-[14px] font-medium" style={{ color: "var(--color-text)" }}>
        {value}
      </dd>
    </div>
  );
}

function Field({
  label,
  value,
  link,
  external,
}: {
  label: string;
  value: string | null;
  link?: string;
  external?: boolean;
}) {
  if (!value) {
    return (
      <div className="flex items-baseline gap-3 text-[13px]">
        <dt className="w-24 shrink-0" style={{ color: "var(--color-text-muted)" }}>
          {label}
        </dt>
        <dd style={{ color: "var(--color-text-muted)" }}>—</dd>
      </div>
    );
  }
  const inner = link ? (
    <a
      href={link}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="hover:underline truncate"
      style={{ color: "var(--color-text)" }}
    >
      {value}
    </a>
  ) : (
    <span className="truncate" style={{ color: "var(--color-text)" }}>
      {value}
    </span>
  );
  return (
    <div className="flex items-baseline gap-3 text-[13px] min-w-0">
      <dt className="w-24 shrink-0" style={{ color: "var(--color-text-muted)" }}>
        {label}
      </dt>
      <dd className="min-w-0">{inner}</dd>
    </div>
  );
}
