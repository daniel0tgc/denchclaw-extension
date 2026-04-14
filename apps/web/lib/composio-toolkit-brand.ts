"use client";

import { useEffect, useState } from "react";
import type { ComposioToolkit, ComposioToolkitsResponse } from "@/lib/composio";
import { extractComposioToolkits } from "@/lib/composio-client";
import {
  getComposioToolkitLookupCandidates,
  normalizeComposioToolkitName,
  normalizeComposioToolkitSlug,
  resolveComposioConnectToolkitSlug,
} from "@/lib/composio-normalization";

const BRAND_CACHE_TTL_MS = 5 * 60_000;

type ComposioToolkitBrand = {
  logo: string | null;
  name: string | null;
};

type CacheEntry<T> =
  | {
      expiresAt: number;
      value: T;
    }
  | {
      expiresAt: number;
      promise: Promise<T>;
    };

const brandCache = new Map<string, CacheEntry<ComposioToolkitBrand | null>>();

function normalizeToolkitLogo(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(trimmed);
  }
  return out;
}

function buildBrandCacheKey(params: {
  toolkitSlug?: string | null;
  toolkitName?: string | null;
}): string | null {
  if (params.toolkitSlug?.trim()) {
    return `slug:${normalizeComposioToolkitSlug(params.toolkitSlug)}`;
  }
  if (params.toolkitName?.trim()) {
    return `name:${params.toolkitName.trim().toLowerCase()}`;
  }
  return null;
}

function buildToolkitSearchQueries(params: {
  toolkitSlug?: string | null;
  toolkitName?: string | null;
}): string[] {
  return uniqueStrings([
    params.toolkitName ?? null,
    ...(params.toolkitSlug?.trim()
      ? getComposioToolkitLookupCandidates(params.toolkitSlug)
      : []),
  ]);
}

export function pickComposioToolkitMatch(
  toolkits: ComposioToolkit[],
  slug: string,
  name?: string | null,
): ComposioToolkit | null {
  const normalizedSlug = normalizeComposioToolkitSlug(slug);
  const normalizedName = name?.trim().toLowerCase() ?? "";
  return toolkits.find((toolkit) =>
    normalizeComposioToolkitSlug(toolkit.slug) === normalizedSlug
    || (normalizedName.length > 0 && toolkit.name.trim().toLowerCase() === normalizedName)
  ) ?? null;
}

async function fetchToolkitBrandForQuery(params: {
  query: string;
  toolkitSlug?: string | null;
  toolkitName?: string | null;
}): Promise<ComposioToolkitBrand | null> {
  const search = new URLSearchParams({
    search: params.query,
    limit: "24",
  });
  const response = await fetch(`/api/composio/toolkits?${search.toString()}`);
  if (!response.ok) {
    return null;
  }
  const payload = await response.json() as ComposioToolkitsResponse;
  const toolkit = pickComposioToolkitMatch(
    extractComposioToolkits(payload).items,
    params.toolkitSlug ?? params.toolkitName ?? "",
    params.toolkitName,
  );
  if (!toolkit) {
    return null;
  }
  return {
    logo: normalizeToolkitLogo(toolkit.logo),
    name: toolkit.name,
  };
}

export async function getComposioToolkitBrand(params: {
  toolkitSlug?: string | null;
  toolkitName?: string | null;
}): Promise<ComposioToolkitBrand | null> {
  const cacheKey = buildBrandCacheKey(params);
  const queries = buildToolkitSearchQueries(params);
  if (!cacheKey || queries.length === 0) {
    return null;
  }

  const now = Date.now();
  const cached = brandCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    if ("value" in cached) {
      return cached.value;
    }
    return cached.promise;
  }

  const promise = (async () => {
    for (const query of queries) {
      const match = await fetchToolkitBrandForQuery({
        query,
        toolkitSlug: params.toolkitSlug,
        toolkitName: params.toolkitName,
      });
      if (match) {
        return match;
      }
    }
    return null;
  })();

  brandCache.set(cacheKey, {
    expiresAt: now + BRAND_CACHE_TTL_MS,
    promise,
  });

  try {
    const value = await promise;
    brandCache.set(cacheKey, {
      expiresAt: Date.now() + BRAND_CACHE_TTL_MS,
      value,
    });
    return value;
  } catch (error) {
    brandCache.delete(cacheKey);
    throw error;
  }
}

export function useComposioToolkitBrand(params: {
  toolkitSlug?: string | null;
  toolkitName?: string | null;
  initialLogo?: string | null;
}) {
  const normalizedInitialLogo = normalizeToolkitLogo(params.initialLogo);
  const normalizedInitialName = params.toolkitName?.trim() ?? null;
  const [brand, setBrand] = useState<ComposioToolkitBrand>({
    logo: normalizedInitialLogo,
    name: normalizedInitialName,
  });

  useEffect(() => {
    setBrand({
      logo: normalizedInitialLogo,
      name: normalizedInitialName,
    });
  }, [normalizedInitialLogo, normalizedInitialName]);

  useEffect(() => {
    if (normalizedInitialLogo) {
      return;
    }
    if (!params.toolkitSlug?.trim() && !params.toolkitName?.trim()) {
      return;
    }

    let cancelled = false;
    void getComposioToolkitBrand({
      toolkitSlug: params.toolkitSlug,
      toolkitName: params.toolkitName,
    }).then((resolved) => {
      if (cancelled || !resolved) {
        return;
      }
      setBrand((current) => ({
        logo: current.logo ?? resolved.logo,
        name: current.name ?? resolved.name,
      }));
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [normalizedInitialLogo, params.toolkitName, params.toolkitSlug]);

  return brand;
}

export function createComposioToolkitPlaceholder(
  slug: string,
  name?: string | null,
): ComposioToolkit {
  const normalizedSlug = normalizeComposioToolkitSlug(slug);
  const fallbackName = normalizeComposioToolkitName(undefined, normalizedSlug);
  return {
    slug: normalizedSlug,
    connect_slug: resolveComposioConnectToolkitSlug(normalizedSlug),
    name: typeof name === "string" && name.trim().length > 0
      ? name.trim()
      : fallbackName.includes("-")
        ? fallbackName.split("-").map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" ")
        : fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1),
    description: "",
    logo: null,
    categories: [],
    auth_schemes: [],
    tools_count: 0,
  };
}
