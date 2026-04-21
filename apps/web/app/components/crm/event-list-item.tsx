"use client";

import { useEffect, useState } from "react";
import { PersonAvatar } from "./person-avatar";
import { CompanyFavicon } from "./company-favicon";
import { formatRelativeDate } from "./format-relative-date";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The minimum-viable shape that all three meeting list contexts (Person
 * profile, Company profile, main Calendar view) can satisfy from their
 * existing list payloads. The richer detail (organizer, attendees with
 * avatars, companies) is fetched lazily on first expand.
 */
export type EventListItemSummary = {
  id: string;
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  meeting_type: string | null;
  /** Optional — used to render a small avatar stack in the collapsed row when known. */
  attendees?: ReadonlyArray<EventDetailPerson>;
  /** Optional — Calendar list provides this; profile views don't bother. */
  google_event_id?: string | null;
};

export type EventDetailPerson = {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

export type EventDetailCompany = {
  id: string;
  name: string | null;
  domain: string | null;
};

type EventDetailResponse = {
  event: {
    id: string;
    title: string | null;
    start_at: string | null;
    end_at: string | null;
    meeting_type: string | null;
    google_event_id: string | null;
  };
  organizer: EventDetailPerson | null;
  attendees: EventDetailPerson[];
  companies: EventDetailCompany[];
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Expandable row for a calendar_event. Collapsed state matches the
 * existing card UI (title + meeting-type chip + time). Click anywhere on
 * the row to expand inline — the detail panel fetches organizer +
 * attendee + company hydration from `/api/crm/calendar/:id` on first
 * open and caches it for subsequent toggles.
 *
 * Same expand/collapse animation pattern as `ProfileThreadList` (grid-rows
 * trick) so visual rhythm matches the Email tab.
 */
export function EventListItem({
  event,
  expanded,
  onToggle,
  onOpenPerson,
  onOpenCompany,
}: {
  event: EventListItemSummary;
  expanded: boolean;
  onToggle: () => void;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
}) {
  const startDate = event.start_at ? new Date(event.start_at) : null;
  const endDate = event.end_at ? new Date(event.end_at) : null;
  const timeRange = startDate
    ? endDate
      ? `${formatTime(startDate)} – ${formatTime(endDate)}`
      : formatTime(startDate)
    : "";

  const collapsedAttendees = (event.attendees ?? []).slice(0, 5);
  const overflow = (event.attendees?.length ?? 0) - collapsedAttendees.length;

  return (
    <li
      className="overflow-hidden"
      style={{
        background: expanded ? "var(--color-surface-hover)" : "transparent",
        transition: "background 120ms ease",
      }}
    >
      {/* Row trigger — div+role="button" so we can nest interactive
          children (attendee avatar buttons, external links) without
          generating invalid HTML. Same approach as ProfileThreadListItem. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) {return;}
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="group/event w-full flex items-center gap-3 px-3 py-2 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] transition-colors"
        onMouseEnter={(e) => {
          if (expanded) {return;}
          (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
        }}
        onMouseLeave={(e) => {
          if (expanded) {return;}
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        {/* Left: time column — the anchor a calendar row actually needs.
            tabular-nums keeps times aligned vertically down the list.
            "11:00 AM – 11:30 AM" is 19 chars, so we reserve enough width
            to fit a full 12h range without clipping the title. */}
        <div
          className="text-[12px] tabular-nums shrink-0 whitespace-nowrap"
          style={{ color: "var(--color-text-muted)", width: "11rem" }}
        >
          {timeRange || (event.start_at ? formatRelativeDate(event.start_at) : "")}
        </div>

        {/* Middle: title + meeting type inline, attendees right-aligned. */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <p
            className="truncate text-[13.5px]"
            style={{ color: "var(--color-text)", fontWeight: 500 }}
          >
            {event.title?.trim() || "(no title)"}
          </p>
          {event.meeting_type && (
            <span
              className="shrink-0 rounded-full px-1.5 py-0 text-[10px] uppercase tracking-[0.06em]"
              style={{
                background: "var(--color-surface-hover)",
                color: "var(--color-text-muted)",
                fontWeight: 600,
              }}
            >
              {event.meeting_type}
            </span>
          )}
        </div>

        {/* Right: attendee avatars + chevron. */}
        <div className="flex shrink-0 items-center gap-2">
          {collapsedAttendees.length > 0 && (
            <div className="flex items-center -space-x-1.5">
              {collapsedAttendees.slice(0, 4).map((person) => (
                <button
                  key={person.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPerson?.(person.id);
                  }}
                  disabled={!onOpenPerson}
                  title={person.name ?? person.email ?? undefined}
                  className="disabled:cursor-default rounded-full"
                  style={{
                    boxShadow: "0 0 0 2px var(--color-background)",
                  }}
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
                <span
                  className="ml-1 text-[11px] tabular-nums"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  +{overflow}
                </span>
              )}
            </div>
          )}
          <Chevron expanded={expanded} />
        </div>
      </div>

      {/* Inline detail — animates open via the grid-rows trick. */}
      <div
        className="grid transition-[grid-template-rows] duration-[220ms] ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {expanded && (
            <EventDetailBody
              eventId={event.id}
              fallbackEvent={event}
              onOpenPerson={onOpenPerson}
              onOpenCompany={onOpenCompany}
            />
          )}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Detail panel (lazy-loaded)
// ---------------------------------------------------------------------------

/**
 * The body that fills the inline-expand area of an `EventListItem` —
 * exported so the per-person Activity timeline can mount the same
 * detail UI when a meeting row is expanded there. The caller is
 * expected to provide a `fallbackEvent` summary so the panel can paint
 * (with date/time at least) before the detail fetch resolves.
 */
export function EventDetailBody({
  eventId,
  fallbackEvent,
  onOpenPerson,
  onOpenCompany,
}: {
  eventId: string;
  fallbackEvent: EventListItemSummary;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
}) {
  const [detail, setDetail] = useState<EventDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/crm/calendar/${encodeURIComponent(eventId)}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) {throw new Error(`HTTP ${r.status}`);}
        return r.json() as Promise<EventDetailResponse>;
      })
      .then((body) => {
        if (cancelled) {return;}
        setDetail(body);
      })
      .catch((err: unknown) => {
        if (cancelled) {return;}
        setError(err instanceof Error ? err.message : "Failed to load meeting details.");
      })
      .finally(() => {
        if (cancelled) {return;}
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const startDate = (detail?.event.start_at ?? fallbackEvent.start_at)
    ? new Date(detail?.event.start_at ?? fallbackEvent.start_at!)
    : null;
  const endDate = (detail?.event.end_at ?? fallbackEvent.end_at)
    ? new Date(detail?.event.end_at ?? fallbackEvent.end_at!)
    : null;
  const dayLabel = startDate ? formatLongDay(startDate) : null;
  const timeRange = startDate
    ? endDate
      ? `${formatTime(startDate)} – ${formatTime(endDate)}`
      : formatTime(startDate)
    : null;
  const duration = startDate && endDate ? formatDuration(startDate, endDate) : null;

  const organizer = detail?.organizer ?? null;
  const attendees = detail?.attendees ?? fallbackEvent.attendees ?? [];
  const companies = detail?.companies ?? [];

  return (
    <div
      className="border-t px-4 py-4"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-background)",
      }}
    >
      {/* When -> a single row of date/time/duration */}
      {(dayLabel || timeRange || duration) && (
        <DetailSection label="When">
          <div
            className="text-[13px]"
            style={{ color: "var(--color-text)" }}
          >
            {dayLabel && <div className="font-medium">{dayLabel}</div>}
            {(timeRange || duration) && (
              <div className="mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                {timeRange}
                {timeRange && duration && " · "}
                {duration}
              </div>
            )}
          </div>
        </DetailSection>
      )}

      {/* Organizer */}
      {organizer && (
        <DetailSection label="Organizer">
          <PersonChip person={organizer} onOpenPerson={onOpenPerson} />
        </DetailSection>
      )}

      {/* Attendees */}
      {attendees.length > 0 && (
        <DetailSection label={`Attendees · ${attendees.length}`}>
          <div className="flex flex-col gap-1.5">
            {attendees.map((person) => (
              <PersonChip
                key={person.id}
                person={person}
                onOpenPerson={onOpenPerson}
              />
            ))}
          </div>
        </DetailSection>
      )}

      {/* Companies */}
      {companies.length > 0 && (
        <DetailSection label={companies.length === 1 ? "Company" : "Companies"}>
          <div className="flex flex-col gap-1.5">
            {companies.map((company) => (
              <CompanyChip
                key={company.id}
                company={company}
                onOpenCompany={onOpenCompany}
              />
            ))}
          </div>
        </DetailSection>
      )}

      {/* Loading / error feedback */}
      {loading && !detail && (
        <p
          className="text-[12px]"
          style={{ color: "var(--color-text-muted)" }}
        >
          Loading meeting details…
        </p>
      )}
      {error && (
        <p
          className="text-[12px]"
          style={{ color: "var(--color-text-muted)" }}
        >
          Couldn&rsquo;t load meeting details ({error}). Showing what we have.
        </p>
      )}

      {/* If we have absolutely nothing to show, give a friendly fallback. */}
      {!loading && !error && detail && attendees.length === 0 && !organizer && companies.length === 0 && (
        <p
          className="text-[12px]"
          style={{ color: "var(--color-text-muted)" }}
        >
          No additional details for this meeting.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function DetailSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <h4
        className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em]"
        style={{ color: "var(--color-text-muted)" }}
      >
        {label}
      </h4>
      {children}
    </div>
  );
}

function PersonChip({
  person,
  onOpenPerson,
}: {
  person: EventDetailPerson;
  onOpenPerson?: (id: string) => void;
}) {
  const displayName = person.name?.trim() || person.email || "Unknown";
  const subtitle = person.name?.trim() && person.email ? person.email : null;
  return (
    <button
      type="button"
      onClick={() => onOpenPerson?.(person.id)}
      disabled={!onOpenPerson}
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors disabled:cursor-default"
      style={{ color: "var(--color-text)" }}
      onMouseEnter={(e) => {
        if (!onOpenPerson) {return;}
        (e.currentTarget as HTMLElement).style.background =
          "var(--color-surface-hover)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      <PersonAvatar
        src={person.avatar_url}
        name={displayName}
        seed={person.email ?? person.id}
        size="sm"
      />
      <div className="min-w-0">
        <p
          className="truncate text-[13px] font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {displayName}
        </p>
        {subtitle && (
          <p
            className="truncate text-[11px]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {subtitle}
          </p>
        )}
      </div>
    </button>
  );
}

function CompanyChip({
  company,
  onOpenCompany,
}: {
  company: EventDetailCompany;
  onOpenCompany?: (id: string) => void;
}) {
  const displayName = company.name?.trim() || company.domain || "Unknown company";
  return (
    <button
      type="button"
      onClick={() => onOpenCompany?.(company.id)}
      disabled={!onOpenCompany}
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors disabled:cursor-default"
      onMouseEnter={(e) => {
        if (!onOpenCompany) {return;}
        (e.currentTarget as HTMLElement).style.background =
          "var(--color-surface-hover)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      <CompanyFavicon domain={company.domain} name={company.name} size="sm" />
      <div className="min-w-0">
        <p
          className="truncate text-[13px] font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {displayName}
        </p>
        {company.domain && company.name && (
          <p
            className="truncate text-[11px]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {company.domain}
          </p>
        )}
      </div>
    </button>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="motion-reduce:transition-none"
      style={{
        color: "var(--color-text-muted)",
        transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 180ms ease",
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Date/time helpers (kept local — same shape as CalendarView's helpers)
// ---------------------------------------------------------------------------

function formatTime(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** Long-form day label, e.g. "Friday, April 16, 2027". */
function formatLongDay(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

/**
 * "55 min", "1h 30m", "2h", "all-day". Accepts dates in either order so
 * a malformed feed doesn't crash the row.
 */
function formatDuration(start: Date, end: Date): string {
  let diffMs = end.getTime() - start.getTime();
  if (diffMs <= 0) {return "";}
  const totalMinutes = Math.round(diffMs / (60 * 1000));
  if (totalMinutes >= 60 * 24) {
    const days = Math.round(totalMinutes / (60 * 24));
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {return `${minutes} min`;}
  if (minutes === 0) {return `${hours}h`;}
  return `${hours}h ${minutes}m`;
}
