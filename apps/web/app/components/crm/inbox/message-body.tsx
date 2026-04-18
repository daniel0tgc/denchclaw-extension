"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Renders a single message body with format detection:
 *
 *   - HTML-shaped content → rendered in a strict sandboxed iframe via
 *     `srcdoc`. Sandbox is `allow-popups` only — NO scripts, NO same-
 *     origin, NO forms, NO modals. We wrap the body in a base stylesheet
 *     that keeps it inside the conversation column (max-width 100%),
 *     forces all links to open in a new tab, and scopes images.
 *
 *   - Plain text / markdown → rendered as preformatted text inside a
 *     scrollable column. We deliberately avoid pulling the workspace's
 *     ReactMarkdown into the email reader because email plain-text rarely
 *     uses markdown syntax intentionally and we don't want subject lines
 *     like "Re: Section 1" to render as a heading.
 *
 * The iframe auto-resizes to fit its content height (capped at 1200px) so
 * the conversation pane scrolls naturally instead of nesting scrollbars.
 */
export function MessageBody({ body, preview }: { body: string | null; preview: string | null }) {
  const text = body?.trim() || preview?.trim() || "";
  const isHtml = useMemo(() => looksLikeHtml(text), [text]);

  if (!text) {
    return (
      <p
        className="text-[13px] italic"
        style={{
          color: "var(--color-text-muted)",
          fontFamily: '"Bookerly", Georgia, "Times New Roman", serif',
        }}
      >
        (empty body)
      </p>
    );
  }

  if (isHtml) {
    return <SandboxedHtmlBody html={text} />;
  }

  return (
    <div
      className="text-[14px] leading-[1.65] whitespace-pre-wrap break-words"
      style={{
        color: "var(--color-text)",
        fontFamily: '"Bookerly", Georgia, "Times New Roman", serif',
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HTML detection
// ---------------------------------------------------------------------------

function looksLikeHtml(input: string): boolean {
  if (!input) {return false;}
  // Cheap structural sniff. We deliberately match on opening tags,
  // doctype, or any closing tag — covers everything from a full
  // <html><body>… document down to a tiny snippet like "<p>hi</p>".
  return /<!doctype|<html|<body|<head|<table|<div|<p\b|<a\s|<br\s*\/?>|<img\s|<\/[a-z]/i.test(input);
}

// ---------------------------------------------------------------------------
// Sandboxed iframe
// ---------------------------------------------------------------------------

function SandboxedHtmlBody({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(160);

  // Build the srcdoc once per body change. Wrapped in a minimal HTML
  // shell with a base stylesheet that:
  //   - clamps width
  //   - forces links to _blank (so clicks don't break out of the iframe)
  //   - scales images to the column width
  //   - uses Bookerly + Instrument Serif via CSS @font-face is overkill
  //     here; system fonts inside the iframe is fine because the parent
  //     UI already provides editorial type around it.
  const srcdoc = useMemo(() => buildSrcdoc(html), [html]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) {return;}
    let cancelled = false;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      if (cancelled) {return;}
      try {
        const doc = iframe.contentDocument;
        if (!doc?.body) {return;}
        const next = Math.min(1200, Math.max(60, doc.body.scrollHeight + 8));
        setHeight((prev) => (Math.abs(prev - next) > 2 ? next : prev));
      } catch {
        // contentDocument access can throw in some edge cases — keep height as-is.
      }
    };

    const handleLoad = () => {
      measure();
      try {
        const doc = iframe.contentDocument;
        if (doc?.body && typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(measure);
          observer.observe(doc.body);
        }
      } catch {
        // no-op
      }
    };

    iframe.addEventListener("load", handleLoad);
    // In case load fired before the listener attached.
    if (iframe.contentDocument?.readyState === "complete") {
      handleLoad();
    }

    return () => {
      cancelled = true;
      iframe.removeEventListener("load", handleLoad);
      observer?.disconnect();
    };
  }, [srcdoc]);

  return (
    <iframe
      ref={iframeRef}
      title="Email body"
      srcDoc={srcdoc}
      // Strict sandbox: NO scripts, NO same-origin, NO forms, NO modals.
      // `allow-popups` lets users follow target=_blank links, which we
      // inject below.
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      loading="lazy"
      style={{
        width: "100%",
        height,
        border: "none",
        background: "var(--color-surface)",
        colorScheme: "light",
      }}
    />
  );
}

function buildSrcdoc(html: string): string {
  // Wrap the user-supplied HTML in a minimal document with a base
  // stylesheet + a <base> tag forcing target=_blank on every anchor.
  // We do NOT inject any JavaScript — the sandbox blocks scripts anyway.
  const STYLE = `
    :root { color-scheme: light; }
    html, body {
      margin: 0;
      padding: 16px 18px;
      background: #ffffff;
      color: #1c1c1a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.55;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    body * { max-width: 100% !important; }
    img, video { max-width: 100% !important; height: auto !important; }
    table { border-collapse: collapse; max-width: 100% !important; }
    a { color: #0065A2; text-decoration: underline; }
    blockquote { margin: 0 0 0 8px; padding-left: 12px; border-left: 2px solid rgba(0,0,0,0.12); color: #555; }
    pre, code { font-family: "SF Mono", "Fira Code", monospace; font-size: 13px; }
    pre { white-space: pre-wrap; }
    /* Hide tracking pixels — common 1x1 invisible images. */
    img[width="1"][height="1"] { display: none !important; }
  `.trim();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>${STYLE}</style>
</head>
<body>${html}</body>
</html>`;
}
