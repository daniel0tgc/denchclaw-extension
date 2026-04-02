import {
  fetchComposioToolkits,
  type ComposioToolkitsResponse,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} from "@/lib/composio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_TOOLKITS_CACHE_TTL_MS = 5 * 60_000;

let cachedDefaultToolkits:
  | {
      expiresAt: number;
      value: ComposioToolkitsResponse;
    }
  | {
      expiresAt: number;
      promise: Promise<ComposioToolkitsResponse>;
    }
  | null = null;

async function fetchDefaultToolkitsCached(
  gatewayUrl: string,
  apiKey: string,
): Promise<ComposioToolkitsResponse> {
  const now = Date.now();
  if (cachedDefaultToolkits && cachedDefaultToolkits.expiresAt > now) {
    if ("value" in cachedDefaultToolkits) {
      return cachedDefaultToolkits.value;
    }
    return cachedDefaultToolkits.promise;
  }

  const promise = fetchComposioToolkits(gatewayUrl, apiKey);
  cachedDefaultToolkits = {
    expiresAt: now + DEFAULT_TOOLKITS_CACHE_TTL_MS,
    promise,
  };

  try {
    const value = await promise;
    cachedDefaultToolkits = {
      expiresAt: Date.now() + DEFAULT_TOOLKITS_CACHE_TTL_MS,
      value,
    };
    return value;
  } catch (error) {
    cachedDefaultToolkits = null;
    throw error;
  }
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

  const { searchParams } = new URL(request.url);
  const gatewayUrl = resolveComposioGatewayUrl();

  try {
    const search = searchParams.get("search") ?? undefined;
    const category = searchParams.get("category") ?? undefined;
    const cursor = searchParams.get("cursor") ?? undefined;
    const limit = searchParams.has("limit")
      ? Number(searchParams.get("limit"))
      : undefined;
    const useDefaultCache = !search && !category && !cursor && limit === undefined;
    const data = useDefaultCache
      ? await fetchDefaultToolkitsCached(gatewayUrl, apiKey)
      : await fetchComposioToolkits(gatewayUrl, apiKey, {
          search,
          category,
          cursor,
          limit,
        });
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch toolkits." },
      { status: 502 },
    );
  }
}
