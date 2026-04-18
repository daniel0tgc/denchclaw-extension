"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import type { OnboardingState } from "@/lib/denchclaw-state";

export type ConnectToolkitProps = {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onRefresh: () => Promise<void>;
  /** UI-facing display name (e.g. "Gmail"). */
  toolkitName: string;
  /** Stable toolkit slug to send to the connect API (e.g. "gmail", "google-calendar"). */
  toolkitSlug: string;
  /** Onboarding-state key for tracking the active connection. */
  storageKey: "gmail" | "calendar";
  /** Headline + body copy shown above the connect button. */
  headline: string;
  description: string;
  /** Bullet points under the description. */
  benefits: string[];
  /** Step name we are currently on, for the state machine PUT. */
  fromStep: "connect-gmail" | "connect-calendar";
  /** Step name to advance to after connect. */
  toStep: "connect-calendar" | "backfill";
  /** When set, allow the user to skip this connection (calendar). */
  allowSkip?: boolean;
};

type ConnectInitiateResponse = {
  redirect_url?: string;
  connection_id?: string | null;
  connect_toolkit?: string | null;
  error?: string;
};

type CallbackPayload = {
  type: string;
  status?: string;
  connected_account_id?: string;
  connected_toolkit_slug?: string | null;
  connected_toolkit_name?: string | null;
};

export function ConnectToolkitStep({
  state,
  onAdvance,
  onRefresh,
  toolkitName,
  toolkitSlug,
  storageKey,
  headline,
  description,
  benefits,
  fromStep,
  toStep,
  allowSkip,
}: ConnectToolkitProps) {
  const [connecting, setConnecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);
  const callbackHandledRef = useRef(false);

  const existing = state.connections?.[storageKey];

  const stopPopupPolling = useCallback(() => {
    if (popupPollRef.current !== null) {
      window.clearInterval(popupPollRef.current);
      popupPollRef.current = null;
    }
  }, []);

  const completeStep = useCallback(
    async (connectionId: string, connectionToolkitSlug: string | null, accountEmail: string | null) => {
      setSubmitting(true);
      try {
        const res = await fetch("/api/onboarding/connections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toolkit: storageKey,
            connectionId,
            toolkitSlug: connectionToolkitSlug ?? toolkitSlug,
            accountEmail,
            fromStep,
            toStep,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const next = (await res.json()) as OnboardingState;
        onAdvance(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the connection.");
      } finally {
        setSubmitting(false);
      }
    },
    [fromStep, onAdvance, storageKey, toStep, toolkitSlug],
  );

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data as CallbackPayload | undefined;
      if (!data || data.type !== "composio-callback") {return;}
      if (event.origin !== window.location.origin) {return;}

      callbackHandledRef.current = true;
      stopPopupPolling();
      popupRef.current = null;
      setConnecting(false);

      if (data.status !== "success" || !data.connected_account_id) {
        setError("Connection was not completed. Please try again.");
        return;
      }

      void onRefresh();
      void completeStep(
        data.connected_account_id,
        data.connected_toolkit_slug ?? null,
        null,
      );
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [completeStep, onRefresh, stopPopupPolling]);

  useEffect(() => () => stopPopupPolling(), [stopPopupPolling]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    callbackHandledRef.current = false;
    try {
      const res = await fetch("/api/composio/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: toolkitSlug }),
      });
      const data = (await res.json()) as ConnectInitiateResponse;
      if (!res.ok || !data.redirect_url) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const popup = window.open(
        data.redirect_url,
        "_blank",
        "popup=yes,width=560,height=720,resizable=yes,scrollbars=yes",
      );
      if (!popup) {
        throw new Error("Popup was blocked. Allow popups for DenchClaw and try again.");
      }
      popupRef.current = popup;
      popup.focus?.();
      popupPollRef.current = window.setInterval(() => {
        const current = popupRef.current;
        if (!current || !current.closed) {return;}
        stopPopupPolling();
        popupRef.current = null;
        if (!callbackHandledRef.current) {
          setConnecting(false);
          setError(
            "The connection window was closed before authorization finished.",
          );
        }
      }, 500);
    } catch (err) {
      setConnecting(false);
      setError(err instanceof Error ? err.message : "Could not start the connection.");
    }
  }, [stopPopupPolling, toolkitSlug]);

  const handleContinue = useCallback(async () => {
    if (!existing) {
      setError(`Connect ${toolkitName} first or skip this step.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromStep, to: toStep }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as OnboardingState;
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not advance.");
    } finally {
      setSubmitting(false);
    }
  }, [existing, fromStep, onAdvance, toStep, toolkitName]);

  const handleSkip = useCallback(async () => {
    if (!allowSkip) {return;}
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromStep, to: toStep, skipping: storageKey }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as OnboardingState;
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not skip.");
    } finally {
      setSubmitting(false);
    }
  }, [allowSkip, fromStep, onAdvance, storageKey, toStep]);

  return (
    <div className="space-y-8">
      <div>
        <p
          className="mb-3 text-xs font-semibold uppercase tracking-[0.18em]"
          style={{ color: "var(--color-text-muted)" }}
        >
          {toolkitName}
        </p>
        <h1
          className="font-instrument text-4xl tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          {headline}
        </h1>
        <p
          className="mt-3 text-[15px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          {description}
        </p>
      </div>

      <ul className="space-y-2.5">
        {benefits.map((item) => (
          <li
            key={item}
            className="flex gap-3 text-[13px]"
            style={{ color: "var(--color-text-muted)" }}
          >
            <span
              aria-hidden
              className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
              style={{ background: "var(--color-accent)", color: "#fff" }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            {item}
          </li>
        ))}
      </ul>

      {existing ? (
        <div
          className="rounded-2xl px-4 py-4"
          style={{
            background: "rgba(16, 185, 129, 0.08)",
            border: "1px solid rgba(16, 185, 129, 0.2)",
          }}
        >
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              style={{ background: "rgb(34, 197, 94)", color: "#fff" }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-medium" style={{ color: "var(--color-text)" }}>
                {toolkitName} connected
              </p>
              <p className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
                {existing.accountEmail || existing.accountLabel || `Connection ${existing.connectionId.slice(-6)}`}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {error && (
        <div
          className="rounded-xl px-4 py-3 text-[13px]"
          style={{
            background: "rgba(239, 68, 68, 0.08)",
            color: "rgb(252, 165, 165)",
            border: "1px solid rgba(239, 68, 68, 0.2)",
          }}
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        {allowSkip && !existing ? (
          <button
            type="button"
            onClick={() => void handleSkip()}
            disabled={submitting || connecting}
            className="text-[13px] underline-offset-4 transition-colors hover:underline disabled:opacity-50"
            style={{ color: "var(--color-text-muted)" }}
          >
            Skip {toolkitName}
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button
            variant={existing ? "outline" : "default"}
            onClick={() => void handleConnect()}
            disabled={connecting || submitting}
          >
            {connecting
              ? "Waiting for authorization…"
              : existing
                ? `Reconnect ${toolkitName}`
                : `Connect ${toolkitName}`}
          </Button>
          {existing && (
            <Button onClick={() => void handleContinue()} disabled={connecting || submitting}>
              {submitting ? "Saving…" : "Continue"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
