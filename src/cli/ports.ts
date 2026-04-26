import { execFileSync, execSync } from "node:child_process";
import { resolveLsofCommandSync } from "../infra/ports-lsof.js";
import { sleep } from "../utils.js";

const IS_WINDOWS = process.platform === "win32";

export type PortProcess = { pid: number; command?: string };

export type ForceFreePortResult = {
  killed: PortProcess[];
  waitedMs: number;
  escalatedToSigkill: boolean;
};

export function parseLsofOutput(output: string): PortProcess[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const results: PortProcess[] = [];
  let current: Partial<PortProcess> = {};
  for (const line of lines) {
    if (line.startsWith("p")) {
      if (current.pid) {
        results.push(current as PortProcess);
      }
      current = { pid: Number.parseInt(line.slice(1), 10) };
    } else if (line.startsWith("c")) {
      current.command = line.slice(1);
    }
  }
  if (current.pid) {
    results.push(current as PortProcess);
  }
  return results;
}

export function parseNetstatOutput(output: string, port: number): PortProcess[] {
  const seen = new Set<number>();
  const results: PortProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes("LISTENING")) continue;
    const columns = trimmed.split(/\s+/);
    const localAddr = columns[1];
    if (!localAddr) continue;
    const addrPort = Number.parseInt(localAddr.slice(localAddr.lastIndexOf(":") + 1), 10);
    if (addrPort !== port) continue;
    const pid = Number.parseInt(columns[columns.length - 1], 10);
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    results.push({ pid });
  }
  return results;
}

function listPortListenersWindows(port: number): PortProcess[] {
  try {
    const out = execSync(`netstat -ano -p TCP`, { encoding: "utf-8", windowsHide: true });
    return parseNetstatOutput(out, port);
  } catch {
    return [];
  }
}

function listPortListenersUnix(port: number): PortProcess[] {
  try {
    const lsof = resolveLsofCommandSync();
    const out = execFileSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpFc"], {
      encoding: "utf-8",
    });
    return parseLsofOutput(out);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      throw new Error("lsof not found; required for --force", { cause: err });
    }
    if (status === 1) {
      return [];
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export function listPortListeners(port: number): PortProcess[] {
  return IS_WINDOWS ? listPortListenersWindows(port) : listPortListenersUnix(port);
}

function terminatePid(pid: number): void {
  if (IS_WINDOWS) {
    try {
      execSync(`taskkill /pid ${pid} /f /t`, { stdio: "ignore", windowsHide: true });
    } catch {
      process.kill(pid);
    }
    return;
  }
  process.kill(pid, "SIGTERM");
}

function forceKillPid(pid: number): void {
  if (IS_WINDOWS) {
    try {
      execSync(`taskkill /pid ${pid} /f /t`, { stdio: "ignore", windowsHide: true });
    } catch {
      process.kill(pid);
    }
    return;
  }
  process.kill(pid, "SIGKILL");
}

export function forceFreePort(port: number): PortProcess[] {
  const listeners = listPortListeners(port);
  for (const proc of listeners) {
    try {
      terminatePid(proc.pid);
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`,
        { cause: err },
      );
    }
  }
  return listeners;
}

function killPids(listeners: PortProcess[], signal: "SIGTERM" | "SIGKILL") {
  for (const proc of listeners) {
    try {
      if (signal === "SIGKILL") {
        forceKillPid(proc.pid);
      } else {
        terminatePid(proc.pid);
      }
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`,
        { cause: err },
      );
    }
  }
}

export async function forceFreePortAndWait(
  port: number,
  opts: {
    /** Total wait budget across signals. */
    timeoutMs?: number;
    /** Poll interval for checking whether listeners remain. */
    intervalMs?: number;
    /** How long to wait after SIGTERM before escalating to SIGKILL (Unix only). */
    sigtermTimeoutMs?: number;
  } = {},
): Promise<ForceFreePortResult> {
  const timeoutMs = Math.max(opts.timeoutMs ?? 1500, 0);
  const intervalMs = Math.max(opts.intervalMs ?? 100, 1);
  const sigtermTimeoutMs = Math.min(Math.max(opts.sigtermTimeoutMs ?? 600, 0), timeoutMs);

  const killed = forceFreePort(port);
  if (killed.length === 0) {
    return { killed, waitedMs: 0, escalatedToSigkill: false };
  }

  if (IS_WINDOWS) {
    let waitedMs = 0;
    const tries = intervalMs > 0 ? Math.ceil(timeoutMs / intervalMs) : 0;
    for (let i = 0; i < tries; i++) {
      if (listPortListeners(port).length === 0) {
        return { killed, waitedMs, escalatedToSigkill: false };
      }
      await sleep(intervalMs);
      waitedMs += intervalMs;
    }
    if (listPortListeners(port).length === 0) {
      return { killed, waitedMs, escalatedToSigkill: false };
    }
    throw new Error(
      `port ${port} still has listeners after --force: ${listPortListeners(port)
        .map((p) => p.pid)
        .join(", ")}`,
    );
  }

  let waitedMs = 0;
  const triesSigterm = intervalMs > 0 ? Math.ceil(sigtermTimeoutMs / intervalMs) : 0;
  for (let i = 0; i < triesSigterm; i++) {
    if (listPortListeners(port).length === 0) {
      return { killed, waitedMs, escalatedToSigkill: false };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  if (listPortListeners(port).length === 0) {
    return { killed, waitedMs, escalatedToSigkill: false };
  }

  const remaining = listPortListeners(port);
  killPids(remaining, "SIGKILL");

  const remainingBudget = Math.max(timeoutMs - waitedMs, 0);
  const triesSigkill = intervalMs > 0 ? Math.ceil(remainingBudget / intervalMs) : 0;
  for (let i = 0; i < triesSigkill; i++) {
    if (listPortListeners(port).length === 0) {
      return { killed, waitedMs, escalatedToSigkill: true };
    }
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }

  const still = listPortListeners(port);
  if (still.length === 0) {
    return { killed, waitedMs, escalatedToSigkill: true };
  }

  throw new Error(
    `port ${port} still has listeners after --force: ${still.map((p) => p.pid).join(", ")}`,
  );
}
