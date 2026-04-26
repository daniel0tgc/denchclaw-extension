"use client";

/**
 * Placeholder strip shown when an email has attachments. We only carry
 * the boolean today (no filenames/MIME), so the affordance is visible
 * but we tell the user what's coming. When the sync stores attachment
 * metadata, swap this for a real strip with mime-type icons + sizes.
 */
export function AttachmentStrip({ count }: { count?: number }) {
  return (
    <div
      className="mt-3 inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]"
      style={{
        background: "var(--color-surface)",
        borderColor: "var(--color-border)",
        color: "var(--color-text-muted)",
      }}
      title="Attachment preview is coming when we wire the Gmail attachment fetch."
    >
      <PaperclipIcon />
      <span>
        {count && count > 1 ? `${count} attachments` : "1 attachment"} · preview coming soon
      </span>
    </div>
  );
}

function PaperclipIcon() {
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
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.5-8.49" />
    </svg>
  );
}
