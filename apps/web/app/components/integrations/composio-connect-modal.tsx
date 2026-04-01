"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  type ComposioToolkit,
  type ComposioConnection,
} from "@/lib/composio";
import { normalizeComposioConnections } from "@/lib/composio-client";

function formatConnectionDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Connected recently";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(timestamp);
}

export function ComposioConnectModal({
  toolkit,
  connections,
  open,
  onOpenChange,
  onConnectionChange,
}: {
  toolkit: ComposioToolkit | null;
  connections: ComposioConnection[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnectionChange: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);
  const callbackHandledRef = useRef(false);

  const normalizedConnections = useMemo(
    () => normalizeComposioConnections(connections),
    [connections],
  );
  const activeConnections = useMemo(
    () => normalizedConnections.filter((connection) => connection.is_active),
    [normalizedConnections],
  );
  const connected = activeConnections.length > 0;

  const stopPopupPolling = useCallback(() => {
    if (popupPollRef.current !== null) {
      window.clearInterval(popupPollRef.current);
      popupPollRef.current = null;
    }
  }, []);

  const clearPopupState = useCallback(() => {
    stopPopupPolling();
    popupRef.current = null;
    callbackHandledRef.current = false;
  }, [stopPopupPolling]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setConnecting(false);
      setDisconnectingId(null);
      clearPopupState();
    }
  }, [clearPopupState, open]);

  useEffect(() => clearPopupState, [clearPopupState]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type !== "composio-callback") return;
      if (event.origin !== window.location.origin) return;

      callbackHandledRef.current = true;
      stopPopupPolling();
      popupRef.current = null;
      setConnecting(false);
      if (event.data.status === "success") {
        onConnectionChange();
      } else {
        setError("Connection was not completed. Please try again.");
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onConnectionChange, stopPopupPolling]);

  const handleConnect = useCallback(async () => {
    if (!toolkit) return;
    setConnecting(true);
    setError(null);
    clearPopupState();
    try {
      const res = await fetch("/api/composio/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: toolkit.slug }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to start connection.");
      }
      const popup = window.open(
        data.redirect_url,
        "_blank",
        "popup=yes,width=560,height=720,resizable=yes,scrollbars=yes",
      );
      if (!popup) {
        throw new Error("Popup was blocked. Please allow popups and try again.");
      }

      popupRef.current = popup;
      callbackHandledRef.current = false;
      popup.focus?.();
      popupPollRef.current = window.setInterval(() => {
        const currentPopup = popupRef.current;
        if (!currentPopup || !currentPopup.closed) return;

        stopPopupPolling();
        popupRef.current = null;
        setConnecting(false);
        if (!callbackHandledRef.current) {
          onConnectionChange();
        }
      }, 500);
    } catch (err) {
      setConnecting(false);
      setError(err instanceof Error ? err.message : "Failed to connect.");
    }
  }, [clearPopupState, onConnectionChange, stopPopupPolling, toolkit]);

  const handleDisconnect = useCallback(async (connectionId: string) => {
    setDisconnectingId(connectionId);
    setError(null);
    try {
      const res = await fetch("/api/composio/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: connectionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to disconnect.");
      }
      onConnectionChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnectingId(null);
    }
  }, [onConnectionChange]);

  if (!toolkit) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg"
              style={{ background: "var(--color-surface-hover)" }}
            >
              {toolkit.logo ? (
                <img src={toolkit.logo} alt="" className="h-6 w-6 object-contain" />
              ) : (
                <span
                  className="text-sm font-semibold uppercase"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {toolkit.name.slice(0, 2)}
                </span>
              )}
            </div>
            <div>
              <DialogTitle>{toolkit.name}</DialogTitle>
              {toolkit.tools_count > 0 && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {toolkit.tools_count} tool{toolkit.tools_count !== 1 ? "s" : ""} available
                </p>
              )}
            </div>
          </div>
        </DialogHeader>

        {toolkit.description && (
          <DialogDescription>{toolkit.description}</DialogDescription>
        )}

        {connected && (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[12px] text-emerald-300">
            {activeConnections.length} connected account{activeConnections.length === 1 ? "" : "s"} available to your AI agent.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-red-300">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {normalizedConnections.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Existing connections
                </h4>
                <span className="text-[11px] text-muted-foreground">
                  {normalizedConnections.length} total
                </span>
              </div>

              {normalizedConnections.map((connection, index) => {
                const buttonLabel = connection.is_active ? "Disconnect" : "Remove";
                const showReconnectBadge = connection.is_same_account_reconnect;
                const showInferredIdentityBadge =
                  connection.account_identity_source !== "gateway_stable_id";
                return (
                  <div
                    key={connection.id}
                    className="rounded-xl border px-3 py-3"
                    style={{
                      borderColor: connection.is_active ? "rgba(16, 185, 129, 0.22)" : "var(--color-border)",
                      background: connection.is_active ? "rgba(16, 185, 129, 0.05)" : "var(--color-surface-hover)",
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">
                            {connection.display_label}
                          </p>
                          <span
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{
                              background: connection.is_active ? "rgba(16, 185, 129, 0.15)" : "var(--color-background)",
                              color: connection.is_active ? "rgb(74 222 128)" : "var(--color-text-muted)",
                              border: connection.is_active
                                ? "1px solid rgba(16, 185, 129, 0.24)"
                                : "1px solid var(--color-border)",
                            }}
                          >
                            {connection.normalized_status}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {connection.account_email || connection.account_name || connection.account_label
                            ? `Added ${formatConnectionDate(connection.created_at)}`
                            : `Connection ${index + 1} · Added ${formatConnectionDate(connection.created_at)}`}
                        </p>
                        {(showReconnectBadge || showInferredIdentityBadge) && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {showReconnectBadge && (
                              <span
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                                style={{
                                  background: "rgba(96, 165, 250, 0.12)",
                                  color: "rgb(147 197 253)",
                                  border: "1px solid rgba(96, 165, 250, 0.2)",
                                }}
                              >
                                Same account reconnected
                              </span>
                            )}
                            {showInferredIdentityBadge && (
                              <span
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                                style={{
                                  background: "var(--color-background)",
                                  color: "var(--color-text-muted)",
                                  border: "1px solid var(--color-border)",
                                }}
                              >
                                Identity inferred
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleDisconnect(connection.id)}
                        disabled={disconnectingId === connection.id}
                      >
                        {disconnectingId === connection.id ? `${buttonLabel}...` : buttonLabel}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              className="rounded-xl border border-dashed px-3 py-4 text-sm text-muted-foreground"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface-hover)",
              }}
            >
              No accounts connected yet. Start by connecting your first {toolkit.name} account.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            size="sm"
            onClick={() => void handleConnect()}
            disabled={connecting}
          >
            {connecting
              ? "Waiting for authorization..."
              : connected
                ? "Connect another account"
                : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
