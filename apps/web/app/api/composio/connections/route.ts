import {
  type ComposioConnectionsResponse,
  type ComposioToolkit,
  fetchComposioConnections,
  fetchComposioToolkits,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} from "@/lib/composio";
import {
  extractComposioConnections,
  extractComposioToolkits,
  normalizeComposioConnections,
} from "@/lib/composio-client";
import { rebuildComposioToolIndexIfReady } from "@/lib/composio-tool-index";
import {
  getComposioToolkitLookupCandidates,
  normalizeComposioToolkitName,
  normalizeComposioToolkitSlug,
} from "@/lib/composio-normalization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONNECTIONS_CACHE_TTL_MS = 15_000;
const TOOLKIT_LOOKUP_CACHE_TTL_MS = 5 * 60_000;
const CONNECTED_TOOLKIT_LOOKUP_LIMIT = 40;
const BACKGROUND_TOOL_INDEX_REFRESH_TTL_MS = 60_000;

type CacheEntry<T> =
  | {
      expiresAt: number;
      value: T;
    }
  | {
      expiresAt: number;
      promise: Promise<T>;
    };

const connectionsCache = new Map<string, CacheEntry<ComposioConnectionsResponse>>();
const toolkitLookupCache = new Map<string, CacheEntry<ComposioToolkit[]>>();
let lastBackgroundToolIndexRefreshAt = 0;

function buildCacheKey(gatewayUrl: string, apiKey: string, suffix = ""): string {
  return `${gatewayUrl}::${apiKey}${suffix ? `::${suffix}` : ""}`;
}

async function readThroughCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    if ("value" in cached) {
      return cached.value;
    }
    return cached.promise;
  }

  const promise = loader();
  cache.set(key, {
    expiresAt: now + ttlMs,
    promise,
  });

  try {
    const value = await promise;
    cache.set(key, {
      expiresAt: Date.now() + ttlMs,
      value,
    });
    return value;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

function createToolkitPlaceholder(slug: string, name: string): ComposioToolkit {
  return {
    slug,
    connect_slug: slug,
    name: normalizeComposioToolkitName(name, slug),
    description: "",
    logo: null,
    categories: [],
    auth_schemes: [],
    tools_count: 0,
  };
}

async function fetchConnectionsCached(
  gatewayUrl: string,
  apiKey: string,
): Promise<ComposioConnectionsResponse> {
  return await readThroughCache(
    connectionsCache,
    buildCacheKey(gatewayUrl, apiKey, "connections"),
    CONNECTIONS_CACHE_TTL_MS,
    async () => await fetchComposioConnections(gatewayUrl, apiKey),
  );
}

async function searchToolkitsCached(
  gatewayUrl: string,
  apiKey: string,
  search: string,
): Promise<ComposioToolkit[]> {
  return await readThroughCache(
    toolkitLookupCache,
    buildCacheKey(gatewayUrl, apiKey, `toolkit-search:${search}`),
    TOOLKIT_LOOKUP_CACHE_TTL_MS,
    async () => extractComposioToolkits(await fetchComposioToolkits(gatewayUrl, apiKey, {
      search,
      limit: CONNECTED_TOOLKIT_LOOKUP_LIMIT,
    })).items,
  );
}

async function resolveConnectedToolkits(
  gatewayUrl: string,
  apiKey: string,
  connections: ComposioConnectionsResponse,
): Promise<ComposioToolkit[]> {
  const normalizedConnections = normalizeComposioConnections(
    extractComposioConnections(connections),
  );
  const activeConnections = normalizedConnections.filter((connection) => connection.is_active);
  const activeSlugs = Array.from(
    new Set(activeConnections.map((connection) => connection.normalized_toolkit_slug)),
  );

  if (activeSlugs.length === 0) {
    return [];
  }

  const toolkits = await Promise.all(activeSlugs.map(async (slug) => {
    for (const search of getComposioToolkitLookupCandidates(slug)) {
      const candidates = await searchToolkitsCached(gatewayUrl, apiKey, search).catch(() => []);
      const exact = candidates.find((toolkit) =>
        normalizeComposioToolkitSlug(toolkit.slug) === slug);
      if (exact) {
        return exact;
      }
    }

    const fallbackName = activeConnections.find((connection) =>
      connection.normalized_toolkit_slug === slug)?.toolkit_name ?? slug;
    return createToolkitPlaceholder(slug, fallbackName);
  }));

  return [...toolkits]
    .sort((left, right) => left.name.localeCompare(right.name));
}

function maybeRefreshToolIndexInBackground(includeToolkits: boolean): void {
  if (!includeToolkits) {
    return;
  }
  const now = Date.now();
  if (now - lastBackgroundToolIndexRefreshAt < BACKGROUND_TOOL_INDEX_REFRESH_TTL_MS) {
    return;
  }
  lastBackgroundToolIndexRefreshAt = now;
  void rebuildComposioToolIndexIfReady().catch(() => {
    // Best-effort background warmup only.
  });
}

export async function GET(request: Request) {
  const apiKey = resolveComposioApiKey();
  if (!apiKey) {
    return Response.json(
      { error: "Dench Cloud API key is required." },
      { status: 403 },
    );
  }

  const eligibility = resolveComposioEligibility();
  if (!eligibility.eligible) {
    return Response.json(
      {
        error: "Dench Cloud must be the primary provider.",
        lockReason: eligibility.lockReason,
        lockBadge: eligibility.lockBadge,
      },
      { status: 403 },
    );
  }

  const gatewayUrl = resolveComposioGatewayUrl();
  const searchParams = new URL(request.url).searchParams;
  const includeToolkits = searchParams.get("include_toolkits") === "1";
  const fresh = searchParams.get("fresh") === "1";

  try {
    const data = fresh
      ? await fetchComposioConnections(gatewayUrl, apiKey)
      : await fetchConnectionsCached(gatewayUrl, apiKey);
    if (includeToolkits) {
      maybeRefreshToolIndexInBackground(includeToolkits);
      return Response.json({
        ...data,
        toolkits: await resolveConnectedToolkits(gatewayUrl, apiKey, data),
      });
    }
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch connections." },
      { status: 502 },
    );
  }
}
