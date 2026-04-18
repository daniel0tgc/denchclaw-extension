"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CrmListShell, CrmEmptyState, CrmLoadingState } from "./crm-list-shell";
import { PersonAvatar } from "./person-avatar";
import { formatDayLabel, formatRelativeDate } from "./format-relative-date";

type Attendee = {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

type EventRow = {
  id: string;
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  organizer: string | null;
  meeting_type: string | null;
  google_event_id: string | null;
  attendees: Attendee[];
};

type Range = "upcoming" | "this_week" | "past";

const RANGES: ReadonlyArray<{ id: Range; label: string }> = [
  { id: "upcoming", label: "Upcoming" },
  { id: "this_week", label: "This week" },
  { id: "past", label: "Past" },
];

export function CalendarView({
  onOpenPerson,
}: {
  onOpenPerson?: (id: string) => void;
}) {
  const [range, setRange] = useState<Range>("upcoming");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
                  <EventRow key={event.id} event={event} onOpenPerson={onOpenPerson} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </CrmListShell>
  );
}

function EventRow({
  event,
  onOpenPerson,
}: {
  event: EventRow;
  onOpenPerson?: (id: string) => void;
}) {
  const startDate = event.start_at ? new Date(event.start_at) : null;
  const endDate = event.end_at ? new Date(event.end_at) : null;
  const timeRange = startDate
    ? endDate
      ? `${formatTime(startDate)} – ${formatTime(endDate)}`
      : formatTime(startDate)
    : "";

  const visibleAttendees = event.attendees.slice(0, 5);
  const overflow = event.attendees.length - visibleAttendees.length;

  return (
    <li
      className="rounded-xl border px-4 py-3"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium" style={{ color: "var(--color-text)" }}>
            {event.title?.trim() || "(no title)"}
          </p>
          <p className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
            {timeRange}
            {event.start_at && (
              <>
                {timeRange && " · "}
                {formatRelativeDate(event.start_at)}
              </>
            )}
          </p>
        </div>
        {event.meeting_type && (
          <span
            className="rounded-full px-2 py-0.5 text-[11px] shrink-0"
            style={{
              background: "var(--color-surface-hover)",
              color: "var(--color-text-muted)",
            }}
          >
            {event.meeting_type}
          </span>
        )}
      </div>
      {visibleAttendees.length > 0 && (
        <div className="mt-2.5 flex items-center gap-1">
          {visibleAttendees.map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() => onOpenPerson?.(person.id)}
              disabled={!onOpenPerson}
              title={person.name ?? person.email ?? undefined}
              className="disabled:cursor-default"
            >
              <PersonAvatar
                src={person.avatar_url}
                name={person.name}
                seed={person.email ?? person.id}
                size="sm"
              />
            </button>
          ))}
          {overflow > 0 && (
            <span className="text-[11px] ml-1" style={{ color: "var(--color-text-muted)" }}>
              +{overflow}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function formatTime(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d);
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const day = out.getDay();
  const diff = (day + 6) % 7; // Monday = 0
  out.setDate(out.getDate() - diff);
  out.setHours(0, 0, 0, 0);
  return out;
}
