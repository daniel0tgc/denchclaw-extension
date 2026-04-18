import {
  getLastProgressEvent,
  subscribeProgress,
  type SyncProgressEvent,
} from "@/lib/sync-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      function send(event: SyncProgressEvent): void {
        if (closed) {return;}
        try {
          controller.enqueue(
            encoder.encode(`event: progress\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          /* stream closed */
        }
      }

      // Replay the most recent event so a reconnecting client immediately
      // sees the current state instead of an empty card.
      const last = getLastProgressEvent();
      if (last) {
        send(last);
      } else {
        controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));
      }

      unsubscribe = subscribeProgress(send);

      heartbeat = setInterval(() => {
        if (closed) {return;}
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          /* closed */
        }
      }, 30_000);

      const teardown = () => {
        if (closed) {return;}
        closed = true;
        if (heartbeat) {clearInterval(heartbeat);}
        if (unsubscribe) {unsubscribe();}
      };

      req.signal.addEventListener("abort", teardown, { once: true });
    },
    cancel() {
      closed = true;
      if (heartbeat) {clearInterval(heartbeat);}
      if (unsubscribe) {unsubscribe();}
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
