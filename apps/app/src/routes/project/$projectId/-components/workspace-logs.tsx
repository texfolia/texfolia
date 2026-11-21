import { IconRefresh } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { cn } from "cn";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import {
  type CompileHistoryEntry,
  compileHistorySchema,
  compileTimeline,
  compileTotalMs,
  containerStart,
  formatDuration,
  type TimelineEvent,
} from "#/lib/compile/compile-history";
import { useWorkspace } from "#/providers/workspace-provider";

const logSchema = z.object({ log: z.string() });

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
function timeZoneLabel() {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(new Date())
    .find((entry) => entry.type === "timeZoneName");
  return part?.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function statusLabel(entry: CompileHistoryEntry) {
  if (entry.status === "failed")
    return entry.error === "Compilation superseded by a newer revision"
      ? "Superseded"
      : "Failed";
  return entry.status === "succeeded"
    ? "Succeeded"
    : entry.status === "running"
      ? "Running"
      : "Queued";
}

// The Logs tab: a short history of recent compiles, a timeline of the selected
// compile, and its raw TeX log. It fetches only while visible.
export function WorkspaceLogs() {
  const { projectId, build } = useWorkspace();
  const [jobs, setJobs] = useState<CompileHistoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(
        `/api/compile/${encodeURIComponent(projectId)}?history=1`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(String(response.status));
      const { jobs } = compileHistorySchema.parse(await response.json());
      setJobs(jobs);
      setError("");
    } catch {
      if (!controller.signal.aborted)
        setError("Recent compiles could not be loaded.");
    }
  }, [projectId]);
  // The job record and the browser's render report land shortly after the
  // build event, so read again a little later.
  const current = build?.current;
  const buildKey = current ? `${current.id}:${current.status}` : "";
  useEffect(() => {
    void load();
    const timers = [2_000, 6_000].map((delay) =>
      setTimeout(() => void load(), delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [load, buildKey]);
  useEffect(() => () => request.current?.abort(), []);
  const entry =
    jobs?.find((job) => job.id === selected) ?? jobs?.[0] ?? undefined;
  const zone = useMemo(timeZoneLabel, []);

  return (
    <section
      aria-label="Compile logs"
      className="flex h-full min-h-0 text-sm max-md:flex-col"
    >
      <div className="flex min-h-0 w-64 shrink-0 flex-col border-r max-md:max-h-32 max-md:w-full max-md:border-r-0 max-md:border-b">
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b px-2">
          <h3 className="text-muted-foreground text-xs font-medium">
            Recent compiles
          </h3>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh recent compiles"
            title="Refresh"
            onClick={() => void load()}
          >
            <IconRefresh />
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive p-2 text-xs">
            {error}
          </p>
        )}
        {jobs && !jobs.length && (
          <p className="text-muted-foreground p-2">No compiles yet.</p>
        )}
        <ul className="min-h-0 flex-1 overflow-auto py-1">
          {jobs?.map((job) => {
            const total = compileTotalMs(job.timing);
            const created = new Date(job.createdAt);
            return (
              <li key={job.id}>
                <button
                  type="button"
                  aria-current={job.id === entry?.id || undefined}
                  className="hover:bg-muted aria-[current]:bg-muted flex w-full items-center gap-2 px-2 py-1 text-left text-xs"
                  onClick={() => setSelected(job.id)}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      job.status === "succeeded"
                        ? "bg-emerald-500"
                        : job.status === "failed"
                          ? statusLabel(job) === "Superseded"
                            ? "bg-muted-foreground"
                            : "bg-destructive"
                          : "bg-amber-500",
                    )}
                  />
                  <span className="tabular-nums">
                    {timeFormat.format(created)}
                  </span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">
                    {statusLabel(job)}
                  </span>
                  {total !== null && (
                    <span className="text-muted-foreground tabular-nums">
                      {formatDuration(total)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {entry ? (
          <CompileDetails key={entry.id} entry={entry} zone={zone} />
        ) : (
          !error && (
            <p className="text-muted-foreground p-3">
              {jobs ? "Compile to see its timeline here." : "Loading…"}
            </p>
          )
        )}
      </div>
    </section>
  );
}

function CompileDetails({
  entry,
  zone,
}: {
  entry: CompileHistoryEntry;
  zone: string;
}) {
  const events = useMemo(() => compileTimeline(entry), [entry]);
  const container = containerStart(entry.timing.compiler);
  const bounds = useMemo(() => {
    const values = events.flatMap((event) =>
      [event.start, event.end, event.at].filter(
        (value): value is number => value !== null,
      ),
    );
    if (!values.length) return null;
    const min = Math.min(...values);
    return { min, span: Math.max(1, Math.max(...values) - min) };
  }, [events]);
  const created = new Date(entry.createdAt);
  return (
    <div className="space-y-3 p-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-medium">
          {statusLabel(entry)} compile · {dayFormat.format(created)}{" "}
          {timeFormat.format(created)}
        </h3>
        {container.kind !== "unknown" && (
          <span className="text-muted-foreground text-xs">
            {container.kind === "cold" ? "Cold start" : "Warm start"}
          </span>
        )}
        <span className="text-muted-foreground ml-auto text-xs">
          Times in your local time ({zone})
        </span>
      </header>
      {entry.error && entry.status === "failed" && (
        <p className="text-destructive text-xs wrap-anywhere">{entry.error}</p>
      )}
      {events.length ? (
        <table className="w-full table-fixed text-xs">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th scope="col" className="w-28 pb-1 font-normal">
                Time
              </th>
              <th scope="col" className="pb-1 font-normal">
                Event
              </th>
              <th scope="col" className="w-20 pb-1 text-right font-normal">
                Duration
              </th>
              <th
                scope="col"
                className="w-[30%] pb-1 pl-3 font-normal max-sm:hidden"
              >
                <span className="sr-only">Waterfall</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <TimelineRow key={event.key} event={event} bounds={bounds} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-muted-foreground text-xs">
          No timeline was recorded for this compile.
        </p>
      )}
      {events.some((event) => event.clock === "browser") && (
        <p className="text-muted-foreground text-xs">
          Browser events are measured in your browser and placed on server time
          using the network round trip of the compile request.
        </p>
      )}
      <RawLog
        jobId={entry.id}
        done={entry.status !== "queued" && entry.status !== "running"}
      />
    </div>
  );
}

function TimelineRow({
  event,
  bounds,
}: {
  event: TimelineEvent;
  bounds: { min: number; span: number } | null;
}) {
  const position =
    bounds && event.start !== null && event.end !== null
      ? {
          left: ((event.start - bounds.min) / bounds.span) * 100,
          width: ((event.end - event.start) / bounds.span) * 100,
        }
      : null;
  return (
    <tr className="border-t">
      <td className="py-1 tabular-nums">
        {event.at !== null ? (
          <time dateTime={new Date(event.at).toISOString()}>
            {event.clock === "browser" && (
              <span
                className="text-muted-foreground"
                title="Measured in your browser, aligned to server time"
              >
                ≈
              </span>
            )}
            {timeFormat.format(event.at)}
          </time>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-1">
        <div className="truncate">{event.label}</div>
        {event.detail && (
          <div className="text-muted-foreground truncate">{event.detail}</div>
        )}
      </td>
      <td className="py-1 text-right tabular-nums">
        {event.durationMs !== null ? formatDuration(event.durationMs) : ""}
      </td>
      <td className="py-1 pl-3 max-sm:hidden" aria-hidden>
        {position && (
          <div className="bg-muted relative h-2 rounded-full">
            <div
              className={cn(
                "absolute inset-y-0 rounded-full",
                event.durationMs === null
                  ? "bg-foreground w-0.5"
                  : event.clock === "browser"
                    ? "bg-sky-500"
                    : "bg-primary",
                event.approximate && "opacity-60",
              )}
              style={{
                left: `${Math.min(100, Math.max(0, position.left))}%`,
                ...(event.durationMs !== null
                  ? { width: `max(2px, ${Math.min(100, position.width)}%)` }
                  : {}),
              }}
            />
          </div>
        )}
      </td>
    </tr>
  );
}

function RawLog({ jobId, done }: { jobId: string; done: boolean }) {
  const { projectId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || !done || log !== null) return;
    const controller = new AbortController();
    void fetch(
      `/api/compile/${encodeURIComponent(projectId)}?job=${encodeURIComponent(jobId)}&log=1`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        setLog(logSchema.parse(await response.json()).log);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("The log could not be loaded.");
      });
    return () => controller.abort();
  }, [open, done, log, projectId, jobId]);
  return (
    <details
      className="rounded-md border"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer px-2 py-1 text-xs font-medium">
        Raw TeX log
      </summary>
      <div className="border-t">
        {!done ? (
          <p className="text-muted-foreground p-2 text-xs">
            The log is available when the compile finishes.
          </p>
        ) : error ? (
          <p role="alert" className="text-destructive p-2 text-xs">
            {error}
          </p>
        ) : log === null ? (
          <p className="text-muted-foreground p-2 text-xs">Loading…</p>
        ) : log ? (
          <pre className="max-h-96 overflow-auto p-2 font-mono text-xs wrap-anywhere whitespace-pre-wrap">
            {log}
          </pre>
        ) : (
          <p className="text-muted-foreground p-2 text-xs">
            This compile produced no log.
          </p>
        )}
      </div>
    </details>
  );
}
