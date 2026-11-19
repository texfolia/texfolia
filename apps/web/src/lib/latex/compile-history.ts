import { z } from "zod";

import { previewTimingSchema } from "./compile-telemetry";

// The Logs tab lists this many recent compiles. Older jobs keep their status
// row for accounting, but their timeline is pruned.
export const compileHistoryLimit = 10;

const duration = z.number().finite().nonnegative();
const instant = z.iso.datetime({ offset: true });

// Persisted on project_job.timing. Each part is optional because jobs can fail
// before the compiler runs, and browser reporting is best effort.
export const compilerTimelineSchema = z.looseObject({
  // Coordinator acceptance; the debounce starts here.
  acceptedAt: instant.optional(),
  engine: z.enum(["tectonic", "texlive", "unknown"]).optional(),
  temperature: z.enum(["cold", "warm", "unknown"]).optional(),
  attempt: z.number().int().positive().optional(),
  debounceMs: duration.optional(),
  delivery: z.enum(["direct", "overflow"]).optional(),
  queueWaitMs: duration.nullable().optional(),
  engineRequestMs: duration.optional(),
  compileMs: duration.nullable().optional(),
  outputMs: duration.nullable().optional(),
  publishMs: duration.optional(),
  cacheUsed: z.boolean().optional(),
  containerStartMs: duration.optional(),
  bootMs: duration.nullable().optional(),
  archiveFetchMs: duration.optional(),
  archiveUnpackMs: duration.optional(),
  archiveStatus: z
    .enum(["restored", "missing", "invalid", "warm", "unavailable"])
    .optional(),
  prewarmed: z.boolean().optional(),
  startedAt: instant.optional(),
  firstPdfAt: instant.optional(),
  engineFinishedAt: instant.optional(),
  publishedAt: instant.optional(),
});
export const jobTimelineSchema = z.object({
  web: z.object({ receivedAt: instant }).optional(),
  compiler: compilerTimelineSchema.optional(),
  client: previewTimingSchema.optional(),
});
export type JobTimeline = z.infer<typeof jobTimelineSchema>;

export function parseJobTimeline(value: unknown): JobTimeline {
  const parsed = jobTimelineSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Keep any part that is still valid rather than dropping the whole record.
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const part = <T>(schema: z.ZodType<T>, key: string) => {
    const result = schema.safeParse(record[key]);
    return result.success ? result.data : undefined;
  };
  return {
    web: part(jobTimelineSchema.shape.web, "web"),
    compiler: part(compilerTimelineSchema, "compiler"),
    client: part(previewTimingSchema, "client"),
  };
}

export const compileHistoryEntrySchema = z.object({
  id: z.uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  error: z.string().nullable(),
  createdAt: instant,
  startedAt: instant.nullable(),
  finishedAt: instant.nullable(),
  timing: z.unknown().transform(parseJobTimeline),
});
export type CompileHistoryEntry = z.infer<typeof compileHistoryEntrySchema>;
export const compileHistorySchema = z.object({
  jobs: z.array(compileHistoryEntrySchema),
});

export type TimelineEvent = {
  key: string;
  label: string;
  // Absolute instant on a server clock, or a browser measurement mapped onto
  // the server clock. Null when only a duration is known.
  at: number | null;
  // Start and end for the waterfall bar; equal for instant events.
  start: number | null;
  end: number | null;
  durationMs: number | null;
  clock: "server" | "browser";
  detail?: string;
  // Positioned from durations rather than a recorded instant.
  approximate?: boolean;
};

export type ContainerStart = {
  kind: "cold" | "warm" | "unknown";
  label: string;
};

export function containerStart(
  compiler: JobTimeline["compiler"],
): ContainerStart {
  if (!compiler) return { kind: "unknown", label: "Container" };
  if (compiler.prewarmed)
    return { kind: "warm", label: "Warm container (prepared while editing)" };
  switch (compiler.archiveStatus) {
    case "warm":
      return {
        kind: "warm",
        label: compiler.cacheUsed
          ? "Warm container, cache hit"
          : "Warm container",
      };
    case "restored":
      return { kind: "cold", label: "Cold start, cache restored" };
    case "missing":
    case "invalid":
    case "unavailable":
      return { kind: "cold", label: "Cold start, no cache" };
    default:
      return { kind: "unknown", label: "Container" };
  }
}

// Maps a browser duration measured from the compile action onto the server
// clock. The request reached the web route at receivedAt, half the network
// round trip after it left the browser. Only the browser's monotonic deltas are
// used; its wall clock never enters the result.
export function browserClock(timing: JobTimeline) {
  const receivedAt = timing.web?.receivedAt;
  const client = timing.client;
  if (
    !receivedAt ||
    client?.requestSentMs === undefined ||
    client.serverMs === undefined
  )
    return null;
  const roundTrip = Math.max(
    0,
    client.submissionMs - client.requestSentMs - client.serverMs,
  );
  const arrivedMs = client.requestSentMs + roundTrip / 2;
  const anchor = Date.parse(receivedAt);
  return {
    roundTripMs: roundTrip,
    toServer: (sinceActionMs: number) => anchor + (sinceActionMs - arrivedMs),
  };
}

const parse = (value: string | null | undefined) =>
  value ? Date.parse(value) : null;

export function compileTimeline(entry: {
  createdAt: string;
  finishedAt: string | null;
  timing: JobTimeline;
}): TimelineEvent[] {
  const { timing } = entry;
  const compiler = timing.compiler;
  const client = timing.client;
  const clock = browserClock(timing);
  const events: TimelineEvent[] = [];
  const point = (
    key: string,
    label: string,
    at: number | null,
    clockKind: TimelineEvent["clock"],
    detail?: string,
  ) => {
    if (at === null || Number.isNaN(at)) return;
    events.push({
      key,
      label,
      at,
      start: at,
      end: at,
      durationMs: null,
      clock: clockKind,
      detail,
    });
  };
  const span = (
    key: string,
    label: string,
    start: number | null,
    durationMs: number | null | undefined,
    options: {
      detail?: string;
      approximate?: boolean;
      clock?: TimelineEvent["clock"];
      // The recorded instant, when it marks the end rather than the start.
      at?: number | null;
    } = {},
  ) => {
    if (durationMs === null || durationMs === undefined) return;
    const valid = start !== null && !Number.isNaN(start);
    events.push({
      key,
      label,
      at:
        options.at !== undefined
          ? options.at
          : valid && !options.approximate
            ? start
            : null,
      start: valid ? start : null,
      end: valid ? start + durationMs : null,
      durationMs,
      clock: options.clock ?? "server",
      detail: options.detail,
      approximate: options.approximate,
    });
  };

  if (clock && client?.requestSentMs !== undefined)
    point(
      "sent",
      "You sent the request",
      clock.toServer(client.requestSentMs),
      "browser",
      `${formatDuration(client.requestSentMs)} after the compile action`,
    );
  point(
    "received",
    "We received it",
    parse(timing.web?.receivedAt) ?? parse(entry.createdAt),
    "server",
    clock
      ? `${formatDuration(clock.roundTripMs)} network round trip`
      : undefined,
  );
  if (compiler) {
    const acceptedAt = parse(compiler.acceptedAt);
    point("accepted", "Accepted by the compiler", acceptedAt, "server");
    span("debounce", "Debounce wait", acceptedAt, compiler.debounceMs, {
      detail: "Batches rapid edits before compiling",
    });
    const startedAt = parse(compiler.startedAt);
    point(
      "started",
      compiler.delivery === "overflow"
        ? "Started from the overflow queue"
        : "Compile started",
      startedAt,
      "server",
      compiler.attempt && compiler.attempt > 1
        ? `Attempt ${compiler.attempt}`
        : undefined,
    );
    const container = containerStart(compiler);
    const archiveMs =
      (compiler.archiveFetchMs ?? 0) + (compiler.archiveUnpackMs ?? 0);
    span("container", container.label, startedAt, compiler.containerStartMs, {
      detail: [
        compiler.bootMs ? `boot ${formatDuration(compiler.bootMs)}` : null,
        archiveMs ? `cache restore ${formatDuration(archiveMs)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
    const finishedAt = parse(compiler.engineFinishedAt);
    const latexStart =
      finishedAt !== null && compiler.compileMs != null
        ? finishedAt - (compiler.outputMs ?? 0) - compiler.compileMs
        : null;
    span("latex", "LaTeX run", latexStart, compiler.compileMs, {
      approximate: true,
      detail:
        compiler.engine && compiler.engine !== "unknown"
          ? compiler.engine
          : undefined,
    });
    point(
      "first-pdf",
      "First PDF byte",
      parse(compiler.firstPdfAt),
      "server",
      "Streamed to you before publishing",
    );
    point("finished", "LaTeX finished", finishedAt, "server");
    const publishedAt = parse(compiler.publishedAt);
    span(
      "published",
      "Published to storage",
      publishedAt !== null && compiler.publishMs !== undefined
        ? publishedAt - compiler.publishMs
        : null,
      compiler.publishMs,
      { at: publishedAt },
    );
  } else point("recorded", "Finished", parse(entry.finishedAt), "server");
  if (clock && client) {
    if (client.firstPdfByteMs != null)
      point(
        "browser-first-pdf",
        "First PDF byte in your browser",
        clock.toServer(client.firstPdfByteMs),
        "browser",
      );
    if (client.notifiedMs !== undefined)
      point(
        "notified",
        "You were notified",
        clock.toServer(client.notifiedMs),
        "browser",
      );
    span(
      "rendered",
      client.outcome === "rendered" ? "PDF rendered" : "PDF preview failed",
      clock.toServer(client.actionToPdfMs - client.previewMs),
      client.previewMs,
      {
        clock: "browser",
        at: clock.toServer(client.actionToPdfMs),
        detail: `${formatDuration(client.actionToPdfMs)} from the compile action`,
      },
    );
  }
  return events.sort(
    (a, b) => (a.start ?? a.at ?? Infinity) - (b.start ?? b.at ?? Infinity),
  );
}

// End-to-end duration for the history list: action to render when the browser
// reported it, otherwise the compiler's own job duration.
export function compileTotalMs(timing: JobTimeline) {
  if (timing.client) return timing.client.actionToPdfMs;
  const compiler = timing.compiler;
  const start = parse(compiler?.acceptedAt);
  const end = parse(compiler?.publishedAt);
  return start !== null && end !== null ? Math.max(0, end - start) : null;
}

export function formatDuration(ms: number) {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
