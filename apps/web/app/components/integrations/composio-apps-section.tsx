"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { ComposioAppCard } from "./composio-app-card";
import { ComposioConnectModal } from "./composio-connect-modal";
import type {
  ComposioConnection,
  ComposioToolkit,
  ComposioToolkitsResponse,
  ComposioConnectionsResponse,
} from "@/lib/composio";
import {
  extractComposioConnections,
  extractComposioToolkits,
  normalizeComposioConnections,
  normalizeComposioToolkitSlug,
} from "@/lib/composio-client";

const FEATURED_SLUGS = [
  "gmail",
  "slack",
  "github",
  "notion",
  "google-calendar",
  "linear",
  "airtable",
  "hubspot",
  "salesforce",
  "jira",
  "asana",
  "discord",
];

const MAX_CATEGORY_PILLS = 8;

type IntegrationsTab = "connected" | "marketplace";

function HomeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function StorefrontIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" />
      <path d="M3 9l1.5-5h15L21 9" />
      <path d="M12 9v12" />
      <path d="M3 9c0 1.66 1.34 3 3 3s3-1.34 3-3" />
      <path d="M9 9c0 1.66 1.34 3 3 3s3-1.34 3-3" />
      <path d="M15 9c0 1.66 1.34 3 3 3s3-1.34 3-3" />
    </svg>
  );
}

const TABS: { id: IntegrationsTab; label: string; icon: () => React.JSX.Element }[] = [
  { id: "connected", label: "Connected", icon: HomeIcon },
  { id: "marketplace", label: "Marketplace", icon: StorefrontIcon },
];

type ComposioAppsState = {
  toolkits: ComposioToolkit[];
  connections: ComposioConnection[];
  categories: string[];
  loading: boolean;
  error: string | null;
  connectionsError: string | null;
};

type ComposioMcpStatus = {
  summary: {
    level: "healthy" | "warning" | "error";
    verified: boolean;
    message: string;
  };
  config: {
    status: "pass" | "fail" | "unknown";
    detail: string;
  };
  gatewayTools: {
    status: "pass" | "fail" | "unknown";
    detail: string;
    toolCount: number | null;
  };
  liveAgent: {
    status: "pass" | "fail" | "unknown";
    detail: string;
    evidence: string[];
  };
  refresh?: {
    attempted: boolean;
    restarted: boolean;
    error: string | null;
    profile: string;
  };
};

export function ComposioAppsSection({
  eligible,
  lockBadge,
}: {
  eligible: boolean;
  lockBadge: string | null;
}) {
  const [activeTab, setActiveTab] = useState<IntegrationsTab>("connected");
  const [state, setState] = useState<ComposioAppsState>({
    toolkits: [],
    connections: [],
    categories: [],
    loading: true,
    error: null,
    connectionsError: null,
  });
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [selectedToolkit, setSelectedToolkit] = useState<ComposioToolkit | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<ComposioMcpStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [repairingMcp, setRepairingMcp] = useState(false);
  const initialFetchStartedRef = useRef(false);

  const fetchMcpStatus = useCallback(async () => {
    try {
      const statusRes = await fetch("/api/composio/status");
      if (statusRes.ok) {
        setMcpStatus((await statusRes.json()) as ComposioMcpStatus);
        setStatusError(null);
        return;
      }

      setMcpStatus(null);
      const err = await statusRes.json().catch(() => ({}));
      setStatusError(
        (err as { error?: string }).error ?? `Failed to load Composio MCP status (${statusRes.status})`,
      );
    } catch (err) {
      setMcpStatus(null);
      setStatusError(err instanceof Error ? err.message : "Failed to load Composio MCP status.");
    }
  }, []);

  const fetchData = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null, connectionsError: null }));
    setStatusError(null);
    try {
      const [toolkitsRes, connectionsRes] = await Promise.all([
        fetch("/api/composio/toolkits"),
        fetch("/api/composio/connections"),
      ]);

      if (!toolkitsRes.ok) {
        const err = await toolkitsRes.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string }).error ?? `Failed to load apps (${toolkitsRes.status})`,
        );
      }

      const toolkitsData = extractComposioToolkits(
        (await toolkitsRes.json()) as ComposioToolkitsResponse,
      );
      let connectionsData: ComposioConnectionsResponse = { items: [] };
      let connectionsError: string | null = null;

      if (connectionsRes.ok) {
        connectionsData = (await connectionsRes.json()) as ComposioConnectionsResponse;
      } else {
        const err = await connectionsRes.json().catch(() => ({}));
        connectionsError = (err as { error?: string }).error
          ?? `Failed to load connections (${connectionsRes.status})`;
      }

      setState({
        toolkits: toolkitsData.items,
        connections: extractComposioConnections(connectionsData),
        categories: toolkitsData.categories,
        loading: false,
        error: null,
        connectionsError,
      });

      void fetchMcpStatus();
    } catch (err) {
      setMcpStatus(null);
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load apps.",
      }));
    }
  }, [fetchMcpStatus]);

  useEffect(() => {
    if (eligible) {
      if (initialFetchStartedRef.current) {
        return;
      }
      initialFetchStartedRef.current = true;
      void fetchData();
    } else {
      initialFetchStartedRef.current = false;
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, [eligible, fetchData]);

  const normalizedConnections = useMemo(
    () => normalizeComposioConnections(state.connections),
    [state.connections],
  );

  const connectionsByToolkit = useMemo(() => {
    const map = new Map<string, typeof normalizedConnections>();
    for (const connection of normalizedConnections) {
      const bucket = map.get(connection.normalized_toolkit_slug);
      if (bucket) {
        bucket.push(connection);
      } else {
        map.set(connection.normalized_toolkit_slug, [connection]);
      }
    }
    return map;
  }, [normalizedConnections]);

  const activeConnectionsByToolkit = useMemo(() => {
    const map = new Map<string, typeof normalizedConnections>();
    for (const [toolkitSlug, connections] of connectionsByToolkit) {
      const activeConnections = connections.filter((connection) => connection.is_active);
      if (activeConnections.length > 0) {
        map.set(toolkitSlug, activeConnections);
      }
    }
    return map;
  }, [connectionsByToolkit]);

  const activeAccountsByToolkit = useMemo(() => {
    const map = new Map<string, typeof normalizedConnections>();
    for (const [toolkitSlug, connections] of activeConnectionsByToolkit) {
      const uniqueAccounts = new Map<string, typeof connections[number]>();
      for (const connection of connections) {
        if (!uniqueAccounts.has(connection.account_identity)) {
          uniqueAccounts.set(connection.account_identity, connection);
        }
      }
      map.set(toolkitSlug, Array.from(uniqueAccounts.values()));
    }
    return map;
  }, [activeConnectionsByToolkit]);

  const filteredToolkits = useMemo(() => {
    let list = [...state.toolkits].sort((left, right) => left.name.localeCompare(right.name));
    if (activeCategory) {
      list = list.filter((t) =>
        t.categories.some((c) => c.toLowerCase() === activeCategory.toLowerCase()),
      );
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.slug.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [state.toolkits, search, activeCategory]);

  const connectedToolkits = useMemo(
    () => filteredToolkits.filter((toolkit) =>
      activeAccountsByToolkit.has(normalizeComposioToolkitSlug(toolkit.slug))),
    [activeAccountsByToolkit, filteredToolkits],
  );

  const availableToolkits = useMemo(
    () => filteredToolkits.filter((toolkit) =>
      !activeAccountsByToolkit.has(normalizeComposioToolkitSlug(toolkit.slug))),
    [activeAccountsByToolkit, filteredToolkits],
  );

  const marketplaceToolkits = useMemo(() => {
    if (search.trim() || activeCategory) {
      return availableToolkits;
    }
    const featuredSet = new Set(FEATURED_SLUGS);
    const featured = availableToolkits.filter((t) => featuredSet.has(t.slug));
    featured.sort((a, b) => FEATURED_SLUGS.indexOf(a.slug) - FEATURED_SLUGS.indexOf(b.slug));
    const rest = availableToolkits.filter((t) => !featuredSet.has(t.slug));
    return [...featured, ...rest];
  }, [activeCategory, availableToolkits, search]);

  const displayCategories = useMemo(
    () => state.categories.slice(0, MAX_CATEGORY_PILLS),
    [state.categories],
  );

  const selectedConnections = selectedToolkit
    ? connectionsByToolkit.get(normalizeComposioToolkitSlug(selectedToolkit.slug)) ?? []
    : null;

  const handleAppClick = useCallback((toolkit: ComposioToolkit) => {
    setSelectedToolkit(toolkit);
    setModalOpen(true);
  }, []);

  const handleConnectionChange = useCallback(() => {
    void fetchData();
  }, [fetchData]);

  const handleRepairMcp = useCallback(async () => {
    setRepairingMcp(true);
    setStatusError(null);
    try {
      const response = await fetch("/api/composio/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repair_mcp" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatusError(
          (payload as { error?: string }).error ?? "Failed to update Composio MCP status.",
        );
        return;
      }
      setMcpStatus(payload as ComposioMcpStatus);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to update Composio MCP status.");
    } finally {
      setRepairingMcp(false);
    }
  }, []);

  if (!eligible) {
    return (
      <div>
        <div
          className="flex items-center justify-center rounded-2xl px-6 py-10"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div className="text-center">
            <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
              Available with Dench Cloud
            </p>
            {lockBadge && (
              <span
                className="mt-2 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-medium"
                style={{
                  background: "var(--color-surface-hover)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {lockBadge}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Tab bar */}
      <div
        className="flex w-fit items-center gap-1 mb-6 rounded-xl p-1"
        style={{ background: "var(--color-surface-hover)" }}
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer flex items-center gap-1.5"
              style={{
                background: activeTab === tab.id ? "var(--color-surface)" : "transparent",
                color: activeTab === tab.id ? "var(--color-text)" : "var(--color-text-muted)",
                boxShadow: activeTab === tab.id ? "var(--shadow-sm)" : "none",
              }}
            >
              <Icon />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={activeTab === "connected" ? "Filter connected apps..." : "Search marketplace..."}
          className="w-full px-3 py-2 rounded-xl text-sm outline-none"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        />
      </div>

      {/* Category pills (marketplace only) */}
      {activeTab === "marketplace" && displayCategories.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setActiveCategory(null)}
            className="rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer"
            style={{
              background: !activeCategory ? "var(--color-accent)" : "var(--color-surface)",
              color: !activeCategory ? "var(--color-bg, #fff)" : "var(--color-text-muted)",
              border: !activeCategory ? "none" : "1px solid var(--color-border)",
            }}
          >
            All
          </button>
          {displayCategories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
              className="rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer"
              style={{
                background: activeCategory === cat ? "var(--color-accent)" : "var(--color-surface)",
                color: activeCategory === cat ? "var(--color-bg, #fff)" : "var(--color-text-muted)",
                border: activeCategory === cat ? "none" : "1px solid var(--color-border)",
              }}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* MCP status (collapsed into a small bar) */}
      {(statusError || (mcpStatus && mcpStatus.summary.level !== "healthy")) && (
        <div
          className="mb-4 flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs"
          style={{
            background: "color-mix(in srgb, var(--color-error, #ef4444) 8%, transparent)",
            color: "var(--color-error, #ef4444)",
            border: "1px solid color-mix(in srgb, var(--color-error, #ef4444) 20%, transparent)",
          }}
        >
          <span className="truncate">
            {statusError ?? mcpStatus?.summary.message ?? "MCP needs attention"}
          </span>
          <button
            type="button"
            onClick={() => void handleRepairMcp()}
            disabled={repairingMcp}
            className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium cursor-pointer transition-colors"
            style={{
              background: "color-mix(in srgb, var(--color-error, #ef4444) 15%, transparent)",
            }}
          >
            {repairingMcp ? "Repairing..." : "Repair"}
          </button>
        </div>
      )}

      {state.loading && (
        <div className="flex items-center justify-center py-16">
          <div
            className="w-6 h-6 border-2 rounded-full animate-spin"
            style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
          />
        </div>
      )}

      {!state.loading && state.error && (
        <div
          className="p-8 text-center rounded-2xl"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
        >
          <p className="text-sm mb-3" style={{ color: "var(--color-text-muted)" }}>
            {state.error}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void fetchData()}>
            Retry
          </Button>
        </div>
      )}

      {!state.loading && !state.error && activeTab === "connected" && (
        <ConnectedTab
          toolkits={connectedToolkits}
          activeAccountsByToolkit={activeAccountsByToolkit}
          connectionsByToolkit={connectionsByToolkit}
          onAppClick={handleAppClick}
        />
      )}

      {!state.loading && !state.error && activeTab === "marketplace" && (
        <MarketplaceTab
          toolkits={marketplaceToolkits}
          onAppClick={handleAppClick}
        />
      )}

      <ComposioConnectModal
        toolkit={selectedToolkit}
        connections={selectedConnections ?? []}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onConnectionChange={handleConnectionChange}
      />
    </div>
  );
}

function ConnectedTab({
  toolkits,
  activeAccountsByToolkit,
  connectionsByToolkit,
  onAppClick,
}: {
  toolkits: ComposioToolkit[];
  activeAccountsByToolkit: Map<string, unknown[]>;
  connectionsByToolkit: Map<string, unknown[]>;
  onAppClick: (toolkit: ComposioToolkit) => void;
}) {
  if (toolkits.length === 0) {
    return (
      <div
        className="p-8 text-center rounded-2xl"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      >
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          No connected apps yet. Head to the Marketplace tab to connect your first app.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {toolkits.map((toolkit) => {
        const toolkitSlug = normalizeComposioToolkitSlug(toolkit.slug);
        const activeConnections = activeAccountsByToolkit.get(toolkitSlug) ?? [];
        const totalConnections = connectionsByToolkit.get(toolkitSlug)?.length ?? 0;
        return (
          <ComposioAppCard
            key={toolkit.slug}
            toolkit={toolkit}
            activeConnections={activeConnections.length}
            totalConnections={totalConnections}
            mode="connected"
            onClick={() => onAppClick(toolkit)}
          />
        );
      })}
    </div>
  );
}

function MarketplaceTab({
  toolkits,
  onAppClick,
}: {
  toolkits: ComposioToolkit[];
  onAppClick: (toolkit: ComposioToolkit) => void;
}) {
  if (toolkits.length === 0) {
    return (
      <div
        className="p-8 text-center rounded-2xl"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      >
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          No apps found.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {toolkits.map((toolkit) => (
        <ComposioAppCard
          key={toolkit.slug}
          toolkit={toolkit}
          activeConnections={0}
          mode="marketplace"
          onClick={() => onAppClick(toolkit)}
        />
      ))}
    </div>
  );
}
