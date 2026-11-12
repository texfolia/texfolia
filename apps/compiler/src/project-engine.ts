import { z } from "zod";

import { createEngineClient } from "./engine";
import type { Engine, ObjectStore } from "./jobs";
import type { EngineTiming } from "./telemetry";

const healthSchema = z.object({
  bootId: z.string(),
  cacheReady: z.boolean(),
  bootMs: z.number().finite().nonnegative().nullable(),
  imageSizeBytes: z.number().int().nonnegative().nullable(),
});
const restoreSchema = z.object({
  archiveUnpackMs: z.number().finite().nonnegative(),
});
const maxArchiveBytes = 33 * 1024 * 1024;

async function archiveBlob(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return new Blob(parts);
      size += value.byteLength;
      if (size > maxArchiveBytes)
        throw new Error("Cache archive exceeds 33 MiB");
      parts.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createProjectEngineClient(options: {
  projectId: string;
  store: ObjectStore;
  fetch: (request: Request) => Promise<Response>;
  baseUrl?: string;
}): Engine {
  const baseUrl = options.baseUrl ?? "http://container";
  let preparing:
    | {
        ready: Promise<unknown>;
        timing: Promise<Partial<EngineTiming>>;
      }
    | undefined;
  let pendingTiming: Partial<EngineTiming> | undefined;

  const prepare = () => {
    if (preparing) return preparing;
    const started = performance.now();
    const ready = options
      .fetch(
        new Request(new URL("/health", baseUrl).href, {
          signal: AbortSignal.timeout(90_000),
        }),
      )
      .then(async (health) => {
        if (!health.ok)
          throw new Error(`Engine health failed (${health.status})`);
        return healthSchema.parse(await health.json());
      });
    const timing = ready
      .then(async (info): Promise<Partial<EngineTiming>> => {
        const timing: Partial<EngineTiming> = {
          containerStartMs: performance.now() - started,
          containerBootId: info.bootId,
          bootMs: info.bootMs,
          imageSizeBytes: info.imageSizeBytes,
          archiveFetchMs: 0,
          archiveUnpackMs: 0,
          archiveBytes: 0,
          archiveStatus: "warm",
        };
        if (info.cacheReady) return timing;
        const fetchStarted = performance.now();
        let archive: Blob | undefined;
        try {
          const body = await options.store.read(
            `projects/${options.projectId}/cache.tar.zst`,
          );
          if (body) archive = await archiveBlob(body);
          timing.archiveStatus = archive ? "restored" : "missing";
        } catch (error) {
          timing.archiveStatus = "unavailable";
          console.warn(
            "Cache archive fetch failed; compiling without restored cache",
            { projectId: options.projectId, error },
          );
        }
        timing.archiveFetchMs = performance.now() - fetchStarted;
        timing.archiveBytes = archive?.size ?? 0;
        const restore = (body?: Blob) =>
          options.fetch(
            new Request(new URL("/cache", baseUrl).href, {
              method: "PUT",
              headers: {
                "X-Project-Id": options.projectId,
                "Content-Type": "application/zstd",
                ...(body ? {} : { "X-Cache-Missing": "1" }),
              },
              body,
              signal: AbortSignal.timeout(90_000),
            }),
          );
        let response = await restore(archive);
        if (response.status === 422 && archive) {
          await response.body?.cancel();
          timing.archiveStatus = "invalid";
          response = await restore();
        }
        if (!response.ok)
          throw new Error(`Cache restore failed (${response.status})`);
        if (response.status !== 204)
          timing.archiveUnpackMs = restoreSchema.parse(
            await response.json(),
          ).archiveUnpackMs;
        return timing;
      })
      .finally(() => {
        preparing = undefined;
      });
    void timing.catch(() => {});
    preparing = { ready, timing };
    return preparing;
  };

  const engine = createEngineClient(options.fetch, baseUrl, () => {
    const preparation = prepare();
    return {
      ready: preparation.ready,
      timing: preparation.timing.then((timing) => {
        const prewarmed =
          pendingTiming?.containerBootId === timing.containerBootId;
        const startup = prewarmed ? pendingTiming : timing;
        pendingTiming = undefined;
        return { ...startup, prewarmed };
      }),
    };
  });
  engine.prewarm = async () => {
    const timing = await prepare().timing;
    if (
      !pendingTiming ||
      pendingTiming.containerBootId !== timing.containerBootId
    )
      pendingTiming = timing;
  };
  return engine;
}
