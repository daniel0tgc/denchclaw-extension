"use client";

import { ParticipantChips, type Participant } from "./participant-chips";

/**
 * Sticky header at the top of the conversation pane. Subject in
 * Instrument Serif, participant strip below, action icons on the right.
 */
export function ConversationHeader({
  subject,
  participants,
  gmailThreadId,
  threadId,
  starred,
  onToggleStar,
  onOpenPerson,
  onToggleFocus,
  focusMode,
  onClose,
}: {
  subject: string | null;
  participants: ReadonlyArray<Participant>;
  gmailThreadId: string | null;
  threadId: string;
  starred: boolean;
  onToggleStar: () => void;
  onOpenPerson?: (id: string) => void;
  onToggleFocus?: () => void;
  focusMode?: boolean;
  /** Single-pane drilldown: back-to-list affordance. */
  onClose?: () => void;
}) {
  const headline = subject?.trim() || "(no subject)";

  return (
    <header
      className="sticky top-0 z-20 px-6 pt-5 pb-3"
      style={{
        background: "var(--color-main-bg)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-start gap-3">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Back to inbox"
            className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            <ChevronLeft />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1
            className="font-instrument tracking-tight"
            style={{
              color: "var(--color-text)",
              fontSize: "clamp(1.5rem, 2.5vw, 2rem)",
              lineHeight: 1.15,
              wordBreak: "break-word",
            }}
            title={headline}
          >
            {headline}
          </h1>
          {participants.length > 0 && (
            <div className="mt-2.5 flex items-center gap-3">
              <ParticipantChips
                participants={participants}
                max={5}
                onOpenPerson={onOpenPerson}
                variant="named"
              />
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <IconButton
            title={starred ? "Unstar" : "Star"}
            onClick={onToggleStar}
            active={starred}
          >
            <StarIcon filled={starred} />
          </IconButton>
          {gmailThreadId && (
            <IconButton
              as="a"
              href={`https://mail.google.com/mail/u/0/#all/${gmailThreadId}`}
              target="_blank"
              rel="noreferrer"
              title="Open in Gmail"
            >
              <ExternalIcon />
            </IconButton>
          )}
          <IconButton
            title="Copy thread ID"
            onClick={() => {
              if (typeof navigator !== "undefined" && navigator.clipboard) {
                void navigator.clipboard.writeText(threadId);
              }
            }}
          >
            <CopyIcon />
          </IconButton>
          {onToggleFocus && (
            <IconButton
              title={focusMode ? "Exit focus mode" : "Focus mode"}
              onClick={onToggleFocus}
              active={!!focusMode}
            >
              {focusMode ? <ExitFocusIcon /> : <EnterFocusIcon />}
            </IconButton>
          )}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Tiny presentational helpers
// ---------------------------------------------------------------------------

type IconButtonBaseProps = {
  title: string;
  active?: boolean;
  children: React.ReactNode;
};

type IconButtonAsButton = IconButtonBaseProps & {
  as?: "button";
  onClick?: () => void;
  href?: never;
  target?: never;
  rel?: never;
};

type IconButtonAsAnchor = IconButtonBaseProps & {
  as: "a";
  href: string;
  target?: string;
  rel?: string;
  onClick?: never;
};

function IconButton(props: IconButtonAsButton | IconButtonAsAnchor) {
  const { title, active, children } = props;
  const baseClass =
    "inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors";
  const style = {
    background: active ? "var(--color-surface-hover)" : "transparent",
    color: active ? "var(--color-text)" : "var(--color-text-muted)",
  };
  if (props.as === "a") {
    return (
      <a
        href={props.href}
        target={props.target}
        rel={props.rel}
        title={title}
        className={`${baseClass} hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]`}
        style={style}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={title}
      className={`${baseClass} hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]`}
      style={style}
    >
      {children}
    </button>
  );
}

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  const fill = filled ? "#f59e0b" : "none";
  const stroke = filled ? "#f59e0b" : "currentColor";
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function EnterFocusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="9 21 3 21 3 15" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="3" y1="21" x2="10" y2="14" />
      <line x1="14" y1="10" x2="21" y2="3" />
    </svg>
  );
}

function ExitFocusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}
