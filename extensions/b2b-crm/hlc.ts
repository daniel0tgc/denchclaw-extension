export interface HLC {
  ts: number;
  counter: number;
  nodeId: string;
}

export function createHLC(nodeId: string): HLC {
  return { ts: Date.now(), counter: 0, nodeId };
}

export function incrementHLC(clock: HLC): HLC {
  const now = Date.now();
  if (now > clock.ts) {
    return { ts: now, counter: 0, nodeId: clock.nodeId };
  }
  return { ts: clock.ts, counter: clock.counter + 1, nodeId: clock.nodeId };
}

export function receiveHLC(local: HLC, remote: HLC): HLC {
  const now = Date.now();
  const maxTs = Math.max(local.ts, remote.ts, now);
  let counter: number;
  if (maxTs === local.ts && maxTs === remote.ts) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (maxTs === local.ts) {
    counter = local.counter + 1;
  } else if (maxTs === remote.ts) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  return { ts: maxTs, counter, nodeId: local.nodeId };
}

export function compareHLC(a: HLC, b: HLC): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
  return 0;
}

export function serializeHLC(hlc: HLC): string {
  return `${hlc.ts}:${hlc.counter}:${hlc.nodeId}`;
}

export function deserializeHLC(s: string): HLC {
  const firstColon = s.indexOf(':');
  const secondColon = s.indexOf(':', firstColon + 1);
  const ts = parseInt(s.slice(0, firstColon), 10);
  const counter = parseInt(s.slice(firstColon + 1, secondColon), 10);
  const nodeId = s.slice(secondColon + 1);
  return { ts, counter, nodeId };
}
