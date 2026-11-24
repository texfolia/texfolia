import { createDb } from "@texfolia/db";

import type { LockProject } from "./access";

// Check every payload; also disconnect silent recipients on the next check.
// Database time and runtime scheduling add to this interval.
export const liveProjectAccessIntervalMs = 5000;

export function streamProjectResponse({
  response,
  connectionString,
  projectId,
  userId,
  signal,
  lock,
}: {
  response: Response;
  connectionString: string;
  projectId: string;
  userId: string;
  signal: AbortSignal;
  lock: LockProject;
}) {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let finish: () => void;
  const check = async (deliver?: () => void) => {
    // Request middleware closes its pool when the response headers return.
    const db = createDb(connectionString);
    try {
      await db.transaction(async (tx) => {
        await lock({
          tx,
          projectId,
          userId,
          access: "read",
          content: "build",
        });
        if (!stopped) deliver?.();
      });
    } finally {
      await db.$client.end();
    }
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        finish = () => {
          if (stopped) return;
          stopped = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          controller.close();
          void reader.cancel().catch(() => {});
        };
        const recheck = async () => {
          try {
            await check();
            if (!stopped)
              timer = setTimeout(recheck, liveProjectAccessIntervalMs);
          } catch {
            finish();
          }
        };
        timer = setTimeout(recheck, liveProjectAccessIntervalMs);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (stopped) return;
          if (done) finish();
          else await check(() => controller.enqueue(value));
        } catch {
          finish();
        }
      },
      cancel() {
        // The consumer has already closed the controller.
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        return reader.cancel();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, response);
}
