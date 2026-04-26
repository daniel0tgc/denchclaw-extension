"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Server, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { AddMcpServerDialog, type AddMcpServerInput } from "./add-mcp-server-dialog";

type McpServerEntry = {
  key: string;
  url: string;
  transport: string;
  hasAuth: boolean;
};

type ActionNotice = {
  tone: "success" | "error";
  message: string;
};

function NoticeBanner({ notice }: { notice: ActionNotice }) {
  const toneClass = notice.tone === "success"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-red-500/30 bg-red-500/10 text-red-300";

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClass}`}>
      {notice.message}
    </div>
  );
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error
      : fallback;
  } catch {
    return fallback;
  }
}

function sortServers(servers: McpServerEntry[]): McpServerEntry[] {
  return [...servers].sort((a, b) => a.key.localeCompare(b.key));
}

export function McpServersSection() {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const fetchServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/mcp");
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `Failed to load MCP servers (${response.status}).`));
      }
      const payload = await response.json() as { servers?: McpServerEntry[] };
      setServers(sortServers(Array.isArray(payload.servers) ? payload.servers : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP servers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchServers();
  }, [fetchServers]);

  const handleAddServer = useCallback(async (input: AddMcpServerInput) => {
    setNotice(null);
    try {
      const response = await fetch("/api/settings/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      if (!response.ok) {
        return await readErrorMessage(response, "Failed to add MCP server.");
      }

      const payload = await response.json() as { server?: McpServerEntry };
      if (payload.server) {
        setServers((current) => sortServers([...current, payload.server as McpServerEntry]));
      } else {
        await fetchServers();
      }
      setNotice({ tone: "success", message: `Added MCP server '${input.key}'.` });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Failed to add MCP server.";
    }
  }, [fetchServers]);

  const handleDeleteServer = useCallback(async (server: McpServerEntry) => {
    const confirmed = window.confirm(`Remove MCP server '${server.key}'?`);
    if (!confirmed) {
      return;
    }

    setDeletingKey(server.key);
    setNotice(null);

    try {
      const response = await fetch("/api/settings/mcp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: server.key }),
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Failed to remove MCP server."));
      }

      setServers((current) => current.filter((entry) => entry.key !== server.key));
      setNotice({ tone: "success", message: `Removed MCP server '${server.key}'.` });
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to remove MCP server.",
      });
    } finally {
      setDeletingKey(null);
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
            MCP Servers
          </h2>
          <p className="mt-1 text-xs leading-5" style={{ color: "var(--color-text-muted)" }}>
            Connect remote MCP servers to expose additional tools in DenchClaw.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="rounded-lg"
          onClick={() => {
            setNotice(null);
            setAddDialogOpen(true);
          }}
          disabled={loading}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add MCP Server
        </Button>
      </div>

      {notice ? <NoticeBanner notice={notice} /> : null}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <div
            className="h-6 w-6 animate-spin rounded-full border-2"
            style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
          />
        </div>
      ) : error ? (
        <div
          className="rounded-xl border px-4 py-6 text-center"
          style={{ borderColor: "var(--color-border)" }}
        >
          <p className="mb-3 text-sm" style={{ color: "var(--color-text-muted)" }}>
            {error}
          </p>
          <Button type="button" variant="outline" onClick={() => void fetchServers()}>
            Retry
          </Button>
        </div>
      ) : servers.length === 0 ? (
        <div
          className="rounded-xl border px-4 py-5"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          <div className="flex items-start gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-lg"
              style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}
            >
              <Server className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
                No MCP servers yet
              </div>
              <p className="mt-1 text-xs leading-5" style={{ color: "var(--color-text-muted)" }}>
                Add a remote MCP endpoint to make its tools available in the app.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => {
            const isDeleting = deletingKey === server.key;
            return (
              <div
                key={server.key}
                className="rounded-xl border px-4 py-4"
                style={{
                  borderColor: "var(--color-border)",
                  background: "var(--color-surface)",
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 gap-3">
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                      style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}
                    >
                      <Server className="h-5 w-5" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-medium" style={{ color: "var(--color-text)" }}>
                          {server.key}
                        </div>
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                          style={{
                            background: "var(--color-surface-hover)",
                            color: "var(--color-text)",
                          }}
                        >
                          {server.transport}
                        </span>
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                          style={{
                            background: "var(--color-surface-hover)",
                            color: "var(--color-text)",
                          }}
                        >
                          {server.hasAuth ? (
                            <ShieldCheck className="h-3 w-3" aria-hidden />
                          ) : (
                            <ShieldOff className="h-3 w-3" aria-hidden />
                          )}
                          <span>{server.hasAuth ? "Authenticated" : "No auth"}</span>
                        </span>
                      </div>
                      <p className="mt-2 text-[11px] uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
                        Remote endpoint
                      </p>
                      <div
                        className="mt-1 truncate text-xs leading-5"
                        style={{ color: "var(--color-text-muted)" }}
                        title={server.url}
                      >
                        {server.url}
                      </div>
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0 rounded-lg"
                    onClick={() => void handleDeleteServer(server)}
                    disabled={isDeleting}
                    aria-label={`Remove ${server.key}`}
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {isDeleting ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <Trash2 className="h-4 w-4" aria-hidden />
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AddMcpServerDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onSubmit={handleAddServer}
      />
    </div>
  );
}
