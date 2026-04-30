import type { ComposioConnectionsResponse, ComposioToolkit } from "@/lib/composio";

const CONNECTIONS_CACHE_TTL_MS = 60_000;
const TOOLKIT_LOOKUP_CACHE_TTL_MS = 5 * 60_000;
const RESOLVED_TOOLKITS_CACHE_TTL_MS = 60_000;

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
const toolkitBulkCache = new Map<string, CacheEntry<ComposioToolkit[]>>();
const resolvedToolkitsCache = new Map<string, CacheEntry<ComposioToolkit[]>>();

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

export function invalidateComposioConnectionsCache(): void {
  connectionsCache.clear();
  resolvedToolkitsCache.clear();
}

export async function fetchConnectionsCached(
  gatewayUrl: string,
  apiKey: string,
  loader: () => Promise<ComposioConnectionsResponse>,
): Promise<ComposioConnectionsResponse> {
  return await readThroughCache(
    connectionsCache,
    buildCacheKey(gatewayUrl, apiKey, "connections"),
    CONNECTIONS_CACHE_TTL_MS,
    loader,
  );
}

export async function fetchBulkToolkitsCached(
  gatewayUrl: string,
  apiKey: string,
  loader: () => Promise<ComposioToolkit[]>,
): Promise<ComposioToolkit[]> {
  return await readThroughCache(
    toolkitBulkCache,
    buildCacheKey(gatewayUrl, apiKey, "toolkits-bulk:100"),
    TOOLKIT_LOOKUP_CACHE_TTL_MS,
    loader,
  );
}

export async function fetchResolvedToolkitsCached(
  gatewayUrl: string,
  apiKey: string,
  activeSlugs: string[],
  loader: () => Promise<ComposioToolkit[]>,
): Promise<ComposioToolkit[]> {
  return await readThroughCache(
    resolvedToolkitsCache,
    buildCacheKey(gatewayUrl, apiKey, `resolved-toolkits:${[...activeSlugs].toSorted().join(",")}`),
    RESOLVED_TOOLKITS_CACHE_TTL_MS,
    loader,
  );
}
