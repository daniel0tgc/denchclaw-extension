"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import type { OnboardingState } from "@/lib/denchclaw-state";
import { ConnectionCard, type ConnectionStatus } from "./connection-card";

type DenchCloudStatus = {
  configured: boolean;
  source: "cli" | "web" | null;
  primaryModel: string | null;
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

type ToolkitKey = "gmail" | "calendar";

/**
 * Step 2. Consolidates Dench Cloud + Gmail + Calendar into a single
 * checklist-style screen. Each card owns its own connect logic but we keep
 * the shared surface (header, status bar, primary CTA) here so the three
 * sources feel like one setup moment, not three.
 *
 * Server-side state machine expects sequential advance events (welcome →
 * identity → dench-cloud → connect-gmail → connect-calendar → backfill).
 * We replay those under the hood on the user's behalf as they complete the
 * cards, so the wizard's notion of "where we are" stays consistent with what
 * the state machine records. When the final card lands and we're already on
 * `backfill` server-side, Continue simply moves the client view forward.
 */
export function SetupStep({
  state,
  onAdvance,
  onStageChange,
  onRefresh,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onStageChange: (stage: "empty" | "dench-cloud" | "gmail" | "calendar") => void;
  onRefresh: () => Promise<void>;
}) {
  const [denchCloudStatus, setDenchCloudStatus] = useState<DenchCloudStatus | null>(null);
  const [denchCloudLoading, setDenchCloudLoading] = useState(true);
  const [denchCloudKeyInput, setDenchCloudKeyInput] = useState("");
  const [denchCloudSubmitting, setDenchCloudSubmitting] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [denchCloudError, setDenchCloudError] = useState<string | null>(null);

  const [activeToolkit, setActiveToolkit] = useState<ToolkitKey | null>(null);
  const [toolkitError, setToolkitError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);

  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);
  const callbackToolkitRef = useRef<ToolkitKey | null>(null);

  // Derived connection flags. `state.denchCloud` is present whenever the user
  // has either configured it or explicitly skipped — `skipped: true` means
  // "user opted out", which for our UI counts as "not connected" (but still
  // allows the state machine to have moved forward).
  const denchCloudRecorded = Boolean(
    state.denchCloud && !state.denchCloud.skipped,
  );
  const denchCloudConnected = Boolean(
    denchCloudRecorded || denchCloudStatus?.configured,
  );
  const gmailConnected = Boolean(state.connections?.gmail);
  const calendarConnected = Boolean(state.connections?.calendar);

  // Report the furthest-reached stage up to the parent so the right pane can
  // show the matching mock fidelity without the parent having to know every
  // server-state combination.
  useEffect(() => {
    let stage: "empty" | "dench-cloud" | "gmail" | "calendar" = "empty";
    if (denchCloudConnected) {stage = "dench-cloud";}
    if (gmailConnected) {stage = "gmail";}
    if (calendarConnected) {stage = "calendar";}
    onStageChange(stage);
  }, [denchCloudConnected, gmailConnected, calendarConnected, onStageChange]);

  // Load Dench Cloud status (checks env/CLI config on disk).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/onboarding/dench-cloud", { cache: "no-store" });
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const data = (await res.json()) as DenchCloudStatus;
        if (cancelled) {return;}
        setDenchCloudStatus(data);
      } catch (err) {
        if (cancelled) {return;}
        setDenchCloudError(
          err instanceof Error ? err.message : "Could not check Dench Cloud.",
        );
      } finally {
        if (!cancelled) {setDenchCloudLoading(false);}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // If Dench Cloud was configured via CLI but not yet recorded in onboarding
  // state, auto-accept it so the step advances without a redundant click.
  useEffect(() => {
    if (denchCloudLoading) {return;}
    if (!denchCloudStatus?.configured) {return;}
    if (state.denchCloud) {return;}
    void (async () => {
      try {
        const res = await fetch("/api/onboarding/dench-cloud", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acceptCli: true }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const next = (await res.json()) as OnboardingState;
        onAdvance(next);
      } catch (err) {
        setDenchCloudError(
          err instanceof Error ? err.message : "Could not record Dench Cloud.",
        );
      }
    })();
  }, [
    denchCloudLoading,
    denchCloudStatus?.configured,
    state.denchCloud,
    onAdvance,
  ]);

  const stopPopupPolling = useCallback(() => {
    if (popupPollRef.current !== null) {
      window.clearInterval(popupPollRef.current);
      popupPollRef.current = null;
    }
  }, []);

  const completeToolkit = useCallback(
    async (
      toolkit: ToolkitKey,
      connectionId: string,
      connectionToolkitSlug: string | null,
    ) => {
      const fromStep = toolkit === "gmail" ? "connect-gmail" : "connect-calendar";
      const toStep = toolkit === "gmail" ? "connect-calendar" : "backfill";
      try {
        const res = await fetch("/api/onboarding/connections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toolkit,
            connectionId,
            toolkitSlug:
              connectionToolkitSlug ??
              (toolkit === "gmail" ? "gmail" : "google-calendar"),
            accountEmail: null,
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
        setToolkitError(
          err instanceof Error ? err.message : "Could not save the connection.",
        );
      }
    },
    [onAdvance],
  );

  // Subscribe to the Composio popup's postMessage callback.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data as CallbackPayload | undefined;
      if (!data || data.type !== "composio-callback") {return;}
      if (event.origin !== window.location.origin) {return;}

      const toolkit = callbackToolkitRef.current;
      stopPopupPolling();
      popupRef.current = null;
      setActiveToolkit(null);
      callbackToolkitRef.current = null;

      if (!toolkit) {return;}
      if (data.status !== "success" || !data.connected_account_id) {
        setToolkitError("Connection was not completed. Please try again.");
        return;
      }
      void onRefresh();
      void completeToolkit(
        toolkit,
        data.connected_account_id,
        data.connected_toolkit_slug ?? null,
      );
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [completeToolkit, onRefresh, stopPopupPolling]);

  useEffect(() => () => stopPopupPolling(), [stopPopupPolling]);

  const startConnect = useCallback(
    async (toolkit: ToolkitKey) => {
      setActiveToolkit(toolkit);
      setToolkitError(null);
      callbackToolkitRef.current = toolkit;
      try {
        const slug = toolkit === "gmail" ? "gmail" : "google-calendar";
        const res = await fetch("/api/composio/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolkit: slug }),
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
          throw new Error(
            "Popup was blocked. Allow popups for DenchClaw and try again.",
          );
        }
        popupRef.current = popup;
        popup.focus?.();
        popupPollRef.current = window.setInterval(() => {
          const current = popupRef.current;
          if (!current || !current.closed) {return;}
          stopPopupPolling();
          popupRef.current = null;
          if (callbackToolkitRef.current) {
            callbackToolkitRef.current = null;
            setActiveToolkit(null);
            setToolkitError(
              "The connection window was closed before authorization finished.",
            );
          }
        }, 500);
      } catch (err) {
        setActiveToolkit(null);
        callbackToolkitRef.current = null;
        setToolkitError(
          err instanceof Error ? err.message : "Could not start the connection.",
        );
      }
    },
    [stopPopupPolling],
  );

  async function handleDenchCloudSubmit(event: React.FormEvent) {
    event.preventDefault();
    setDenchCloudError(null);
    const trimmed = denchCloudKeyInput.trim();
    if (!trimmed) {
      setDenchCloudError("Paste your Dench Cloud API key to continue.");
      return;
    }
    setDenchCloudSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/dench-cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as OnboardingState;
      onAdvance(next);
      setShowKeyForm(false);
      setDenchCloudKeyInput("");
    } catch (err) {
      setDenchCloudError(
        err instanceof Error ? err.message : "Could not save the API key.",
      );
    } finally {
      setDenchCloudSubmitting(false);
    }
  }

  async function handleDenchCloudSkip() {
    setDenchCloudSubmitting(true);
    setDenchCloudError(null);
    try {
      const res = await fetch("/api/onboarding/dench-cloud", { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as OnboardingState;
      onAdvance(next);
      setShowKeyForm(false);
    } catch (err) {
      setDenchCloudError(
        err instanceof Error ? err.message : "Could not skip.",
      );
    } finally {
      setDenchCloudSubmitting(false);
    }
  }

  // Calendar is optional: when the user explicitly skips we still need to
  // advance the state machine to `backfill`.
  async function handleSkipCalendar() {
    setToolkitError(null);
    setAdvancing(true);
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "connect-calendar",
          to: "backfill",
          skipping: "calendar",
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as OnboardingState;
      onAdvance(next);
    } catch (err) {
      setToolkitError(
        err instanceof Error ? err.message : "Could not skip calendar.",
      );
    } finally {
      setAdvancing(false);
    }
  }

  const gmailBlocked = !denchCloudConnected;
  const calendarBlocked = !gmailConnected;

  const denchCloudStatusValue: ConnectionStatus = denchCloudConnected
    ? "connected"
    : denchCloudSubmitting
      ? "connecting"
      : "idle";

  const gmailStatusValue: ConnectionStatus = gmailConnected
    ? "connected"
    : activeToolkit === "gmail"
      ? "connecting"
      : gmailBlocked
        ? "blocked"
        : "idle";

  const calendarStatusValue: ConnectionStatus = calendarConnected
    ? "connected"
    : activeToolkit === "calendar"
      ? "connecting"
      : calendarBlocked
        ? "blocked"
        : "idle";

  const requiredComplete = denchCloudConnected && gmailConnected;
  // User may have skipped Dench Cloud (which also implicitly means skipping
  // Gmail). In that case they still need a path forward: the state machine
  // auto-advances through subsequent steps when DC is skipped, so we treat
  // being past `connect-calendar` as "ready for sync".
  const canContinue =
    requiredComplete || state.currentStep === "backfill" || state.currentStep === "complete";

  async function handleContinueToSync() {
    setToolkitError(null);
    if (state.currentStep === "backfill") {
      // Force the parent into step 3 (the effect only listens to currentStep
      // transitions from the server; here we already are on backfill but the
      // client view is still on setup, so we re-hand the state up). Also
      // refresh to pull the latest state from the server.
      onAdvance(state);
      void onRefresh();
      return;
    }
    // When on connect-calendar and the user has already connected calendar
    // (rare — the postMessage flow usually auto-advances), push the state
    // forward manually.
    if (state.currentStep === "connect-calendar" && calendarConnected) {
      setAdvancing(true);
      try {
        const res = await fetch("/api/onboarding/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: "connect-calendar", to: "backfill" }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const next = (await res.json()) as OnboardingState;
        onAdvance(next);
      } catch (err) {
        setToolkitError(
          err instanceof Error ? err.message : "Could not continue.",
        );
      } finally {
        setAdvancing(false);
      }
      return;
    }
    // Otherwise refresh to let the state machine settle.
    void onRefresh();
  }

  return (
    <div className="space-y-8">
      <div>
        <p
          className="mb-3 text-xs font-semibold uppercase tracking-[0.18em]"
          style={{ color: "var(--color-text-muted)" }}
        >
          Setup
        </p>
        <h1
          className="font-instrument text-[34px] leading-[1.1] tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Connect the three things that matter.
        </h1>
        <p
          className="mt-3 text-[14.5px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          Dench Cloud powers models and integrations. Gmail fills your People
          view. Calendar sharpens the ranking. Calendar&apos;s optional; the
          other two pull their weight.
        </p>
      </div>

      <div className="space-y-3">
        {/* Dench Cloud */}
        <ConnectionCard
          id="dc-card"
          required
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.5 19a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 14.9" />
              <path d="M12 13v8" />
              <path d="m9 18 3 3 3-3" />
            </svg>
          }
          title="Dench Cloud"
          description="AI models + Composio integrations. Powers Gmail/Calendar sync."
          secondaryLabel={
            denchCloudConnected
              ? denchCloudStatus?.primaryModel
                ? `Primary model: ${denchCloudStatus.primaryModel}`
                : "Connected via your Dench Cloud account."
              : "AI models + Composio integrations. Powers Gmail/Calendar sync."
          }
          status={denchCloudStatusValue}
          actions={
            denchCloudLoading ? (
              <span
                className="inline-block h-8 w-24 animate-pulse rounded-md"
                style={{ background: "var(--color-surface-hover)" }}
              />
            ) : denchCloudConnected ? (
              <Button variant="outline" size="sm" disabled>
                Connected
              </Button>
            ) : showKeyForm ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShowKeyForm(false)}
                disabled={denchCloudSubmitting}
              >
                Cancel
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => setShowKeyForm(true)}
              >
                Connect
              </Button>
            )
          }
        />

        {showKeyForm && !denchCloudConnected && (
          <form
            onSubmit={(e) => void handleDenchCloudSubmit(e)}
            className="ml-14 space-y-3 rounded-xl px-4 py-4"
            style={{
              background: "var(--color-surface-hover)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="dench-cloud-key">Dench Cloud API key</Label>
              <Input
                id="dench-cloud-key"
                type="password"
                placeholder="dench_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={denchCloudKeyInput}
                onChange={(e) => setDenchCloudKeyInput(e.target.value)}
                autoComplete="off"
                autoFocus
                disabled={denchCloudSubmitting}
              />
              <p
                className="text-[11.5px]"
                style={{ color: "var(--color-text-muted)" }}
              >
                Get a key at{" "}
                <a
                  href="https://dench.com/api"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--color-accent)" }}
                >
                  dench.com/api
                </a>
                .
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => void handleDenchCloudSkip()}
                disabled={denchCloudSubmitting}
                className="text-[12px] underline-offset-4 transition-colors hover:underline disabled:opacity-50"
                style={{ color: "var(--color-text-muted)" }}
              >
                Skip — use without Gmail sync
              </button>
              <Button type="submit" size="sm" disabled={denchCloudSubmitting}>
                {denchCloudSubmitting ? "Validating…" : "Save key"}
              </Button>
            </div>
          </form>
        )}

        {/* Gmail */}
        <ConnectionCard
          required
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="20" height="14" x="2" y="5" rx="2" />
              <path d="m2 7 10 7 10-7" />
            </svg>
          }
          title="Gmail"
          description="We read your inbox so People and Companies can appear."
          secondaryLabel={
            gmailConnected
              ? state.connections?.gmail?.accountEmail ??
                state.connections?.gmail?.accountLabel ??
                "Connected."
              : gmailBlocked
                ? "Connect Dench Cloud first."
                : "We read your inbox so People and Companies can appear."
          }
          status={gmailStatusValue}
          disabledReason={gmailBlocked ? "Requires Dench Cloud." : undefined}
          actions={
            gmailConnected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void startConnect("gmail")}
                disabled={activeToolkit !== null}
              >
                Reconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void startConnect("gmail")}
                disabled={gmailBlocked || activeToolkit !== null}
              >
                {activeToolkit === "gmail" ? "Authorizing…" : "Connect"}
              </Button>
            )
          }
        />

        {/* Calendar (optional) */}
        <ConnectionCard
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="4" rx="2" />
              <path d="M16 2v4" />
              <path d="M8 2v4" />
              <path d="M3 10h18" />
            </svg>
          }
          title="Google Calendar"
          description="Meetings sharpen your strongest-connection ranking. Optional."
          secondaryLabel={
            calendarConnected
              ? state.connections?.calendar?.accountEmail ??
                state.connections?.calendar?.accountLabel ??
                "Connected."
              : calendarBlocked
                ? "Connect Gmail first."
                : "Meetings sharpen your strongest-connection ranking. Optional."
          }
          status={calendarStatusValue}
          statusLabel={
            calendarConnected
              ? "Connected"
              : state.currentStep === "backfill" && !calendarConnected
                ? "Skipped"
                : undefined
          }
          disabledReason={calendarBlocked ? "Requires Gmail." : undefined}
          actions={
            calendarConnected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void startConnect("calendar")}
                disabled={activeToolkit !== null}
              >
                Reconnect
              </Button>
            ) : state.currentStep === "backfill" ? (
              <Button variant="outline" size="sm" disabled>
                Skipped
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                {gmailConnected && (
                  <button
                    type="button"
                    onClick={() => void handleSkipCalendar()}
                    disabled={advancing || activeToolkit !== null}
                    className="text-[12px] underline-offset-4 transition-colors hover:underline disabled:opacity-50"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    Skip
                  </button>
                )}
                <Button
                  size="sm"
                  onClick={() => void startConnect("calendar")}
                  disabled={calendarBlocked || activeToolkit !== null}
                >
                  {activeToolkit === "calendar" ? "Authorizing…" : "Connect"}
                </Button>
              </div>
            )
          }
        />
      </div>

      {(denchCloudError || toolkitError) && (
        <div
          className="rounded-xl px-4 py-3 text-[13px]"
          style={{
            background: "rgba(239, 68, 68, 0.08)",
            color: "var(--color-error)",
            border: "1px solid rgba(239, 68, 68, 0.2)",
          }}
        >
          {denchCloudError ?? toolkitError}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          {requiredComplete
            ? "All set — head to sync when you're ready."
            : denchCloudConnected
              ? "Gmail is required to continue."
              : "Dench Cloud unlocks the other two."}
        </p>
        <Button
          onClick={() => void handleContinueToSync()}
          disabled={!canContinue || advancing}
        >
          {advancing ? "Opening sync…" : "Continue to sync"}
        </Button>
      </div>
    </div>
  );
}
