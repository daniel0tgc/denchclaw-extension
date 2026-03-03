import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverProfiles, getEffectiveProfile } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type GatewayMeta = {
  mode?: string;
  port?: number;
  url?: string;
};

function readGatewayMeta(stateDir: string): GatewayMeta | null {
  for (const filename of ["openclaw.json", "config.json"]) {
    const configPath = join(stateDir, filename);
    if (!existsSync(configPath)) {
      continue;
    }
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
        gateway?: { mode?: unknown; port?: unknown };
      };
      const port = typeof raw.gateway?.port === "number"
        ? raw.gateway.port
        : typeof raw.gateway?.port === "string"
          ? Number.parseInt(raw.gateway.port, 10)
          : undefined;
      const mode = typeof raw.gateway?.mode === "string" ? raw.gateway.mode : undefined;
      return {
        ...(mode ? { mode } : {}),
        ...(Number.isFinite(port) ? { port } : {}),
        ...(Number.isFinite(port) ? { url: `ws://127.0.0.1:${port}` } : {}),
      };
    } catch {
      // Continue to fallback config file candidate.
    }
  }
  return null;
}

export async function GET() {
  const activeProfile = getEffectiveProfile() ?? "default";
  const profiles = discoverProfiles().map((profile) => ({
    ...profile,
    gateway: readGatewayMeta(profile.stateDir),
  }));

  return Response.json({
    profiles,
    activeProfile,
  });
}
