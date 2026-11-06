import { z } from "zod";

import { HttpError, jobIdSchema, parseProject, type Project } from "./project";

const common = { id: jobIdSchema, digest: z.string(), createdAt: z.string() };
const queuedSchema = z.object({ ...common, status: z.literal("queued") });
const runningSchema = z.object({ ...common, status: z.literal("running") });
const succeededSchema = z.object({
  ...common,
  status: z.literal("succeeded"),
  log: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  artifactUrl: z.string(),
});
const failedSchema = z.object({
  ...common,
  status: z.literal("failed"),
  error: z.string(),
  log: z.string(),
  errorStatus: z.number().int().min(400).max(599),
});
const terminalSchema = z.discriminatedUnion("status", [
  succeededSchema,
  failedSchema,
]);
type TerminalJob = z.infer<typeof terminalSchema>;
type Job = z.infer<typeof queuedSchema | typeof runningSchema> | TerminalJob;

export interface ObjectStore {
  read(key: string): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<{ size: number; metadata?: string } | null>;
  create(
    key: string,
    value: string | Uint8Array,
    metadata?: string,
  ): Promise<boolean>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string): AsyncIterable<string>;
}
export interface JobQueue {
  send(message: { id: string }): Promise<void>;
}
export type Engine = (
  project: Project,
) => Promise<{ pdf: Uint8Array; log: string }>;
const maxAttempts = 4;
const redeliverAfterMs = 60 * 60_000;

export function createJobs(options: {
  store: ObjectStore;
  queue: JobQueue;
  engine: Engine;
}) {
  const { store, queue, engine } = options;
  const readJson = async (key: string): Promise<unknown> => {
    const body = await store.read(key);
    return body ? new Response(body).json() : null;
  };
  const sourceKey = (id: string) => `sources/${id}.json`;
  const pending = async (id: string) => {
    const object = await store.head(sourceKey(id));
    return object
      ? queuedSchema.parse(JSON.parse(object.metadata ?? "null"))
      : null;
  };
  const terminal = async (id: string) => {
    const value = await readJson(`results/${id}.json`);
    return value === null ? null : terminalSchema.parse(value);
  };
  const get = async (id: string): Promise<Job | null> => {
    const result = await terminal(id);
    if (result) return result;
    const job = await pending(id);
    // The consumer may have committed the result and removed sources since our first read.
    if (!job) return terminal(id);
    return (await store.head(`running/${id}`))
      ? { ...job, status: "running" }
      : job;
  };
  const cleanup = async (id: string) => {
    await store.remove(`transcripts/${id}`);
    await store.remove(`sent/${id}`);
    await store.remove(sourceKey(id));
    await store.remove(`running/${id}`);
  };
  const dispatch = async (id: string) => {
    const sentAt = await readJson(`sent/${id}`);
    if (typeof sentAt === "number" && Date.now() - sentAt < redeliverAfterMs)
      return;
    await queue.send({ id });
    await store.write(`sent/${id}`, String(Date.now()));
    if (await terminal(id)) await store.remove(`sent/${id}`);
  };

  return {
    get,
    async submit(id: string, project: Project): Promise<Job> {
      const body = JSON.stringify(project);
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const job: Job = {
        id,
        digest,
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      let saved = await get(id);
      if (!saved) {
        await store.create(sourceKey(id), body, JSON.stringify(job));
        saved = await get(id);
      }
      if (!saved) throw new Error("Job was not persisted");
      if (saved.digest !== digest)
        throw new HttpError(
          409,
          "Compilation ID already used for different sources",
        );
      if (saved.status === "queued" || saved.status === "running") {
        // The source is a durable outbox. Recovery resends it if send fails or
        // the API exits between the R2 write and the Queue call.
        try {
          await dispatch(id);
        } catch (error) {
          console.error("Compile dispatch failed; recovery will retry", {
            jobId: id,
            error,
          });
        }
      }
      return saved;
    },
    async artifact(id: string): Promise<ReadableStream<Uint8Array> | null> {
      const result = await terminal(id);
      if (result?.status === "failed" || (!result && (await pending(id))))
        return null;
      // Older compilations have a PDF but no job record in the compiler store.
      return store.read(`compilations/${id}.pdf`);
    },
    async recover() {
      for await (const key of store.keys("sources/")) {
        const id = jobIdSchema.safeParse(
          key.slice("sources/".length, -".json".length),
        );
        if (!id.success) continue;
        try {
          if (await terminal(id.data)) await cleanup(id.data);
          else await dispatch(id.data);
        } catch (error) {
          console.error("Compile queue recovery failed", {
            jobId: id.data,
            error,
          });
        }
      }
    },
    // Returns false for infrastructure faults that need another delivery.
    // Run serially in both adapters, matching the singleton TeX host.
    async consume(id: string, attempt: number): Promise<boolean> {
      if (await terminal(id)) {
        await cleanup(id);
        return true;
      }
      const job = await pending(id);
      if (!job) return true;
      await store.create(`running/${id}`, "running");
      let result: TerminalJob;
      try {
        const pdfKey = `compilations/${id}.pdf`;
        const transcriptKey = `transcripts/${id}`;
        // Write the log before the PDF so a retry after publishing the PDF can
        // recover its matching log without running TeX a second time.
        const previous = await store.head(pdfKey);
        let log: string;
        let sizeBytes: number;
        if (previous) {
          const transcript = await store.read(transcriptKey);
          log = transcript ? await new Response(transcript).text() : "";
          sizeBytes = previous.size;
        } else {
          const output = await engine(
            parseProject(await readJson(sourceKey(id))),
          );
          await store.write(transcriptKey, output.log);
          await store.create(pdfKey, output.pdf);
          log = output.log;
          sizeBytes = output.pdf.byteLength;
        }
        result = {
          ...job,
          status: "succeeded",
          log,
          sizeBytes,
          artifactUrl: `/${pdfKey}`,
        };
      } catch (error) {
        if (!(error instanceof HttpError) && attempt < maxAttempts)
          return false;
        result = {
          ...job,
          status: "failed",
          error:
            error instanceof HttpError
              ? error.message
              : "Compilation service failed",
          log: error instanceof HttpError ? error.log : "",
          errorStatus: error instanceof HttpError ? error.status : 502,
        };
      }
      await store.create(`results/${id}.json`, JSON.stringify(result));
      await cleanup(id);
      return true;
    },
  };
}
export type Jobs = ReturnType<typeof createJobs>;
