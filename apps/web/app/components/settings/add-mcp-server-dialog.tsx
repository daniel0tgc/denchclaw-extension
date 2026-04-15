"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export type AddMcpServerInput = {
  key: string;
  url: string;
  authToken: string | null;
};

type AddMcpServerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: AddMcpServerInput) => Promise<string | null>;
};

export function AddMcpServerDialog({
  open,
  onOpenChange,
  onSubmit,
}: AddMcpServerDialogProps) {
  const keyInputRef = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setKey("");
    setUrl("");
    setAuthToken("");
    setError(null);
    setSubmitting(false);
    setTimeout(() => keyInputRef.current?.focus(), 100);
  }, [open]);

  const handleSubmit = async () => {
    if (!key.trim()) {
      setError("Please enter a server name.");
      return;
    }
    if (!url.trim()) {
      setError("Please enter a server URL.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const submitError = await onSubmit({
        key: key.trim(),
        url: url.trim(),
        authToken: authToken.trim() || null,
      });

      if (submitError) {
        setError(submitError);
        return;
      }

      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add MCP Server</DialogTitle>
          <DialogDescription>
            Connect a remote MCP server over streamable HTTP. Auth is optional and uses a
            Bearer token header.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label
              className="mb-1.5 block text-sm font-medium"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Server name
            </label>
            <input
              ref={keyInputRef}
              type="text"
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !submitting) {
                  void handleSubmit();
                }
              }}
              placeholder="e.g. acme-mcp"
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
            <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
              Use only letters, numbers, hyphens, or underscores.
            </p>
          </div>

          <div>
            <label
              className="mb-1.5 block text-sm font-medium"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Server URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !submitting) {
                  void handleSubmit();
                }
              }}
              placeholder="https://mcp.example.com"
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
          </div>

          <div>
            <label
              className="mb-1.5 block text-sm font-medium"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Auth token
            </label>
            <input
              type="password"
              value={authToken}
              onChange={(event) => {
                setAuthToken(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !submitting) {
                  void handleSubmit();
                }
              }}
              placeholder="Optional Bearer token"
              className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              style={{
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
            <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
              If provided, this is stored as an <code>Authorization: Bearer ...</code> header.
            </p>
          </div>

          <div
            className="rounded-xl border px-3 py-2 text-xs"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface)",
              color: "var(--color-text-muted)",
            }}
          >
            Transport: <span style={{ color: "var(--color-text)" }}>streamable-http</span>
          </div>

          {error && (
            <p
              className="rounded-lg px-3 py-2 text-sm"
              style={{ background: "rgba(220, 38, 38, 0.08)", color: "var(--color-error)" }}
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="rounded-lg px-4"
            style={{ color: "var(--color-text-muted)", background: "transparent" }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || !key.trim() || !url.trim()}
            className="rounded-lg px-5"
            style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}
          >
            <span className="inline-flex items-center gap-2">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              <span>{submitting ? "Adding..." : "Add Server"}</span>
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
