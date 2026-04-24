import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const CRON_DIR = join(resolveOpenClawStateDir(), "cron");
const JOBS_FILE = join(CRON_DIR, "jobs.json");
const OPENCLAW_CONFIG_FILE = join(resolveOpenClawStateDir(), "openclaw.json");

// Default when the user hasn't customized agents.defaults.heartbeat.every.
// Mirrors the bootstrap default applied by ensureAgentDefaults() in
// src/cli/bootstrap-external.ts.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60_000;

type CronStoreFile = {
  version: 1;
  jobs: Array<Record<string, unknown>>;
};

/** Read cron jobs.json, returning empty array if missing or invalid. */
function readJobsFile(): Array<Record<string, unknown>> {
  if (!existsSync(JOBS_FILE)) {return [];}
  try {
    const raw = readFileSync(JOBS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as CronStoreFile;
    if (parsed && Array.isArray(parsed.jobs)) {return parsed.jobs;}
    return [];
  } catch {
    return [];
  }
}

/** Compute next wake time from job states (minimum nextRunAtMs among enabled jobs). */
function computeNextWakeAtMs(jobs: Array<Record<string, unknown>>): number | null {
  let min: number | null = null;
  for (const job of jobs) {
    if (job.enabled !== true) {continue;}
    const state = job.state as Record<string, unknown> | undefined;
    if (!state) {continue;}
    const next = state.nextRunAtMs;
    if (typeof next === "number" && Number.isFinite(next)) {
      if (min === null || next < min) {min = next;}
    }
  }
  return min;
}

/**
 * Parse OpenClaw duration strings like "24h", "30m", "1h30m", "45s", "2d"
 * into milliseconds. Compound units sum (e.g. "1h30m" -> 5_400_000).
 * Returns null for empty input or strings with no recognisable units.
 */
export function parseDurationToMs(value: string): number | null {
  if (typeof value !== "string") {return null;}
  const trimmed = value.trim();
  if (!trimmed) {return null;}
  const unitMs: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const matches = trimmed.matchAll(/(\d+)\s*([smhd])/gi);
  let total = 0;
  let matched = false;
  let consumed = 0;
  for (const m of matches) {
    matched = true;
    const amount = Number(m[1]);
    const unit = m[2].toLowerCase();
    total += amount * unitMs[unit];
    consumed += m[0].length;
  }
  if (!matched) {return null;}
  // Reject inputs with junk between/around the duration tokens (e.g. "24h junk").
  const stripped = trimmed.replaceAll(/\s+/g, "");
  if (consumed !== stripped.length) {return null;}
  return total;
}

/**
 * Read agents.defaults.heartbeat.every from the active openclaw.json and
 * return the configured interval in milliseconds. Falls back to the
 * Dench-recommended default (24h) when the key is missing or unparseable
 * so the dashboard never silently shows a wrong number.
 */
function readHeartbeatIntervalMs(): number {
  try {
    if (!existsSync(OPENCLAW_CONFIG_FILE)) {return DEFAULT_HEARTBEAT_INTERVAL_MS;}
    const raw = readFileSync(OPENCLAW_CONFIG_FILE, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const agents = cfg.agents as { defaults?: { heartbeat?: { every?: unknown } } } | undefined;
    const every = agents?.defaults?.heartbeat?.every;
    if (typeof every === "string") {
      const parsed = parseDurationToMs(every);
      if (parsed != null && parsed > 0) {return parsed;}
    }
  } catch {
    // ignore — fall through to default
  }
  return DEFAULT_HEARTBEAT_INTERVAL_MS;
}

/**
 * Estimate when the next heartbeat will fire based on the most recent agent
 * session activity plus the configured interval. Returns null when no session
 * activity is available.
 */
function estimateNextHeartbeatMs(intervalMs: number): number | null {
  try {
    const agentsDir = join(resolveOpenClawStateDir(), "agents");
    if (!existsSync(agentsDir)) {return null;}

    const agentDirs = readdirSync(agentsDir, { withFileTypes: true });
    let latestHeartbeat: number | null = null;

    for (const d of agentDirs) {
      if (!d.isDirectory()) {continue;}
      const storePath = join(agentsDir, d.name, "sessions", "sessions.json");
      if (!existsSync(storePath)) {continue;}
      try {
        const raw = readFileSync(storePath, "utf-8");
        const store = JSON.parse(raw) as Record<string, { updatedAt?: number }>;
        // Look for the main agent session (shortest key, most recently updated)
        for (const [key, entry] of Object.entries(store)) {
          if (key.startsWith("agent:") && !key.includes(":cron:") && entry.updatedAt) {
            if (latestHeartbeat === null || entry.updatedAt > latestHeartbeat) {
              latestHeartbeat = entry.updatedAt;
            }
          }
        }
      } catch {
        // skip
      }
    }

    if (latestHeartbeat) {return latestHeartbeat + intervalMs;}
  } catch {
    // ignore
  }
  return null;
}

/** Read heartbeat config + estimated next fire time. */
function readHeartbeatInfo(): { intervalMs: number; nextDueEstimateMs: number | null } {
  const intervalMs = readHeartbeatIntervalMs();
  const nextDueEstimateMs = estimateNextHeartbeatMs(intervalMs);
  return { intervalMs, nextDueEstimateMs };
}

/** GET /api/cron/jobs -- list all cron jobs with heartbeat & status info */
export async function GET() {
  const jobs = readJobsFile();
  const heartbeat = readHeartbeatInfo();
  const nextWakeAtMs = computeNextWakeAtMs(jobs);

  return Response.json({
    jobs,
    heartbeat,
    cronStatus: {
      enabled: jobs.length > 0,
      nextWakeAtMs,
    },
  });
}
