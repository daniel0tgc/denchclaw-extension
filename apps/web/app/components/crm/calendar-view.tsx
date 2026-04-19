"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CrmListShell, CrmEmptyState, CrmLoadingState } from "./crm-list-shell";
import { formatDayLabel } from "./format-relative-date";
import { EventListItem, type EventDetailPerson } from "./event-list-item";

type EventRow = {
  id: string;
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  organizer: string | null;
  meeting_type: string | null;
  google_event_id: string | null;
  attendees: EventDetailPerson[];
};

type Range = "upcoming" | "this_week" | "past";

const RANGES: ReadonlyArray<{ id: Range; label: string }> = [
  { id: "upcoming", label: "Upcoming" },
  { id: "this_week", label: "This week" },
  { id: "past", label: "Past" },
];

export function CalendarView({
  onOpenPerson,
  onOpenCompany,
}: {
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
}) {
  const [range, setRange] = useState<Range>("upcoming");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        const now = new Date();
        if (range === "upcoming") {
          params.set("from", new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString());
        } else if (range === "this_week") {
          const weekStart = startOfWeek(now);
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekStart.getDate() + 7);
          params.set("from", weekStart.toISOString());
          params.set("to", weekEnd.toISOString());
        } else {
          params.set("to", now.toISOString());
        }
        params.set("limit", "200");
        const res = await fetch(`/api/crm/calendar?${params.toString()}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const body = (await res.json()) as { events: EventRow[]; total: number };
        // Re-sort upcoming ASC, past DESC.
        const sorted = [...body.events].toSorted((a, b) => {
          const aT = a.start_at ? Date.parse(a.start_at) : 0;
          const bT = b.start_at ? Date.parse(b.start_at) : 0;
          return range === "past" ? bT - aT : aT - bT;
        });
        setEvents(sorted);
        setTotal(body.total);
      } catch (err) {
        if ((err as Error).name === "AbortError") {return;}
        setError(err instanceof Error ? err.message : "Failed to load calendar.");
      } finally {
        setLoading(false);
      }
    },
    [range],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const grouped = useMemo(() => {
    const groups = new Map<string, EventRow[]>();
    for (const event of events) {
      const day = event.start_at ? formatDayLabel(event.start_at) : "Unknown date";
      if (!groups.has(day)) {groups.set(day, []);}
      groups.get(day)!.push(event);
    }
    return Array.from(groups.entries());
  }, [events]);

  return (
    <CrmListShell title="Calendar" count={total ?? undefined}>
      <div
        className="sticky top-0 z-10 flex flex-wrap items-center gap-1 px-6 py-3"
        style={{
          background: "var(--color-background)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        {RANGES.map((r) => {
          const active = range === r.id;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              className="rounded-full px-3 py-1 text-[12px] font-medium transition-colors"
              style={{
                background: active ? "var(--color-text)" : "transparent",
                color: active ? "var(--color-background)" : "var(--color-text-muted)",
                border: active ? "1px solid var(--color-text)" : "1px solid var(--color-border)",
              }}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="px-6 py-3 text-[13px]" style={{ color: "var(--color-text-muted)" }}>
          {error}
        </div>
      )}

      {loading && events.length === 0 ? (
        <CrmLoadingState />
      ) : events.length === 0 ? (
        <CrmEmptyState
          title="No events"
          description="Connect Google Calendar in onboarding to import events."
        />
      ) : (
        <div className="px-6 py-4">
          {grouped.map(([day, dayEvents]) => (
            <section key={day} className="mb-6 last:mb-0">
              <h3
                className="sticky top-[57px] z-[1] mb-2 px-1 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]"
                style={{ color: "var(--color-text-muted)", background: "var(--color-background)" }}
              >
                {day}
              </h3>
              <ul className="space-y-2">
                {dayEvents.map((event) => (
                  <EventListItem
                    key={event.id}
                    event={event}
                    expanded={expandedId === event.id}
                    onToggle={() =>
                      setExpandedId((prev) => (prev === event.id ? null : event.id))
                    }
                    onOpenPerson={onOpenPerson}
                    onOpenCompany={onOpenCompany}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </CrmListShell>
  );
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const day = out.getDay();
  const diff = (day + 6) % 7; // Monday = 0
  out.setDate(out.getDate() - diff);
  out.setHours(0, 0, 0, 0);
  return out;
}
