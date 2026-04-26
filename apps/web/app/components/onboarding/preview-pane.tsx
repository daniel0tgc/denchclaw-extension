"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export type PreviewVariant = "editorial" | "workspace-mock" | "workspace-live";

/**
 * Right-side preview container. Crossfades between variants (260ms) so that
 * step transitions feel like the same surface taking on a new identity rather
 * than a hard swap. The `variantKey` should change whenever the child content
 * represents a new "slide"; we keep the previous children alive for the
 * fade-out so the transition is seamless.
 */
export function PreviewPane({
  variantKey,
  children,
}: {
  variantKey: string;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState<{ key: string; node: ReactNode }>({
    key: variantKey,
    node: children,
  });
  const [previous, setPrevious] = useState<{ key: string; node: ReactNode } | null>(null);
  const fadeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (variantKey === current.key) {
      // Same slide; update content in place (e.g. live counters).
      setCurrent({ key: variantKey, node: children });
      return;
    }
    setPrevious(current);
    setCurrent({ key: variantKey, node: children });
    if (fadeTimerRef.current !== null) {
      window.clearTimeout(fadeTimerRef.current);
    }
    fadeTimerRef.current = window.setTimeout(() => {
      setPrevious(null);
      fadeTimerRef.current = null;
    }, 260);
    return () => {
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantKey, children]);

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ background: "var(--color-main-bg)" }}
    >
      {/* Ambient radial wash; purely decorative so the right pane reads as
          a distinct surface without a hard divider. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(110% 80% at 80% 10%, var(--color-accent-light) 0%, transparent 55%), radial-gradient(90% 60% at 0% 100%, var(--color-surface-hover) 0%, transparent 60%)",
          opacity: 0.6,
        }}
      />

      {previous && (
        <div
          key={`prev-${previous.key}`}
          className="absolute inset-0 flex h-full w-full items-center justify-center motion-safe:animate-[previewFadeOut_260ms_ease-out_forwards]"
          aria-hidden
        >
          {previous.node}
        </div>
      )}
      <div
        key={`cur-${current.key}`}
        className="absolute inset-0 flex h-full w-full items-center justify-center motion-safe:animate-[previewFadeIn_260ms_ease-out]"
      >
        {current.node}
      </div>

      <style>{`
        @keyframes previewFadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes previewFadeOut {
          from { opacity: 1; transform: translateY(0); }
          to   { opacity: 0; transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}
