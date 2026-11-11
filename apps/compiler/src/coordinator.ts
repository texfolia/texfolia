import { z } from "zod";

import {
  artifactManifestSchema,
  decodeBase64,
  readCache,
  storeArtifacts,
  type ArtifactManifest,
} from "./artifacts";
import type { Engine, ObjectStore } from "./jobs";
import {
  EngineError,
  HttpError,
  jobIdSchema,
  parseProject,
  type Project,
} from "./project";
import {
  emitCompileEvent,
  jobTimingSchema,
  planSchema,
  unknownEngineTiming,
} from "./telemetry";

const common = {
  id: jobIdSchema,
  revision: z.number().int().nonnegative(),
  digest: z.string(),
  createdAt: z.string(),
  plan: planSchema,
  log: z.string().default(""),
  builtBy: z.string().default("Unknown"),
  clean: z.boolean().default(false),
  timing: jobTimingSchema.optional(),
};
const buildSchema = z.discriminatedUnion("status", [
  z.object({ ...common, status: z.literal("queued") }),
  z.object({ ...common, status: z.literal("running") }),
  z.object({
    ...common,
    status: z.literal("succeeded"),
    artifactUrl: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  }),
  z.object({ ...common, status: z.literal("failed"), error: z.string() }),
]);
export const coordinatorSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  artifacts: artifactManifestSchema.nullable().default(null),
  stale: z.boolean().default(false),
  current: buildSchema.nullable(),
  latestBuild: buildSchema.nullable(),
});
export type CoordinatorSnapshot = z.infer<typeof coordinatorSnapshotSchema>;
type Build = z.infer<typeof buildSchema>;
export const editorVersionSchema = z.object({
  editorId: jobIdSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const savedSchema = coordinatorSnapshotSchema.extend({
  lastActivity: z.number().default(Date.now),
  cacheValid: z.boolean().default(true),
  editors: z.record(jobIdSchema, z.number().int().nonnegative()).default({}),
  pending: z
    .object({
      project: z.unknown().transform(parseProject),
      due: z.number(),
      attempt: z.number(),
    })
    .nullable(),
});

const retentionMs = 30 * 24 * 60 * 60_000;

// All state transitions use this implementation in both SQLite and Durable Objects.
// Engine I/O runs outside the writer so a newer edit can cancel it immediately.
export class ProjectCoordinatorCore {
  private state: z.infer<typeof savedSchema>;
  private writer = Promise.resolve();
  private active: {
    id: string;
    controller: AbortController;
    done: Promise<void>;
  } | null = null;
  private listeners = new Set<(snapshot: CoordinatorSnapshot) => void>();

  constructor(
    private options: {
      projectId: string;
      saved: string | null;
      save: (value: string) => void;
      schedule: (at: number) => Promise<void>;
      overflow: () => Promise<void>;
      store: ObjectStore;
      engine: Engine;
    },
  ) {
    this.state = options.saved
      ? savedSchema.parse(JSON.parse(options.saved))
      : {
          revision: 0,
          artifacts: null,
          stale: false,
          lastActivity: Date.now(),
          cacheValid: true,
          current: null,
          latestBuild: null,
          pending: null,
          editors: {},
        };
  }

  snapshot(): CoordinatorSnapshot {
    const { revision, current, latestBuild, artifacts, stale } = this.state;
    return structuredClone({
      revision,
      current,
      latestBuild,
      artifacts,
      stale,
    });
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.writer.then(action);
    this.writer = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private persist() {
    this.options.save(JSON.stringify(this.state));
    for (const listener of this.listeners) listener(this.snapshot());
  }

  async submit(
    id: string,
    project: Project,
    plan: z.infer<typeof planSchema>,
    version?: z.infer<typeof editorVersionSchema>,
    buildOptions: { clean: boolean; builtBy: string } = {
      clean: false,
      builtBy: "Unknown",
    },
  ) {
    return this.exclusive(async () => {
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify(project)),
          ),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      const existing = await this.get(id);
      if (existing) {
        if (existing.digest !== digest)
          throw new HttpError(
            409,
            "Compilation ID already used for different sources",
          );
        return existing;
      }
      if (
        version &&
        version.sequence < (this.state.editors[version.editorId] ?? -1)
      )
        throw new HttpError(409, "Source revision superseded by a newer edit");
      if (version) this.state.editors[version.editorId] = version.sequence;
      const previous = this.state.current;
      const supersededId =
        previous &&
        (previous.status === "queued" || previous.status === "running")
          ? previous.id
          : undefined;
      if (previous && supersededId) {
        await this.options.store.write(
          this.resultKey(previous.id),
          JSON.stringify({
            ...previous,
            status: "failed",
            error: "Compilation superseded by a newer revision",
          }),
        );
      }
      // Persist the new revision and its wake-up before returning acceptance.
      const current: Build = {
        id,
        revision: this.state.revision + 1,
        digest,
        status: "queued",
        createdAt: new Date().toISOString(),
        plan,
        log: "",
        ...buildOptions,
      };
      this.state = {
        ...this.state,
        revision: current.revision,
        stale: this.state.stale || this.state.artifacts?.digest !== digest,
        cacheValid: buildOptions.clean ? false : this.state.cacheValid,
        lastActivity: Date.now(),
        current,
        pending: { project, due: Date.now() + 300, attempt: 0 },
      };
      this.persist();
      this.active?.controller.abort();
      await this.options.schedule(Date.now() + 300);
      return { ...current, supersededId };
    });
  }

  async changed(version?: z.infer<typeof editorVersionSchema>) {
    return this.exclusive(async () => {
      if (
        version &&
        version.sequence <= (this.state.editors[version.editorId] ?? -1)
      )
        return;
      if (version) this.state.editors[version.editorId] = version.sequence;
      this.state.revision++;
      this.state.stale = true;
      this.state.lastActivity = Date.now();
      this.persist();
      if (!this.state.pending)
        await this.options.schedule(Date.now() + retentionMs);
    });
  }

  async clear() {
    this.active?.controller.abort();
    await this.active?.done;
    await this.exclusive(async () => {
      this.state.artifacts = null;
      this.state.latestBuild = null;
      this.state.current = null;
      this.state.pending = null;
      this.persist();
      for await (const key of this.options.store.keys(
        `projects/${this.options.projectId}/`,
      ))
        await this.options.store.remove(key);
    });
  }

  private async pruneArtifacts() {
    const keep = new Set(this.state.artifacts?.files.map((file) => file.key));
    for await (const key of this.options.store.keys(
      `projects/${this.options.projectId}/builds/`,
    ))
      if (!keep.has(key)) await this.options.store.remove(key);
    for await (const key of this.options.store.keys(
      `projects/${this.options.projectId}/compilations/`,
    ))
      await this.options.store.remove(key);
  }

  async file(path: string, version?: string) {
    const file = this.state.artifacts?.files.find((file) => file.path === path);
    return file && (!version || file.key === version)
      ? this.options.store.read(file.key)
      : null;
  }

  private resultKey(id: string) {
    return `projects/${this.options.projectId}/results/${id}.json`;
  }
  private pdfKey(id: string) {
    return `projects/${this.options.projectId}/compilations/${id}.pdf`;
  }

  async get(id: string): Promise<Build | null> {
    if (this.state.current?.id === id)
      return structuredClone(this.state.current);
    const body = await this.options.store.read(this.resultKey(id));
    return body ? buildSchema.parse(await new Response(body).json()) : null;
  }

  async artifact(id: string) {
    const manifest = this.state.artifacts;
    if (manifest?.id === id)
      return manifest.pdf ? this.file(manifest.pdf) : null;
    if (manifest) return null;
    const build = await this.get(id);
    return build?.status === "succeeded"
      ? this.options.store.read(this.pdfKey(id))
      : null;
  }

  async wake() {
    if (
      !this.state.pending &&
      Date.now() - this.state.lastActivity >= retentionMs
    ) {
      await this.clear();
      return;
    }
    const execution = await this.exclusive(async () => {
      const { pending, current } = this.state;
      if (!pending || !current) {
        if (this.state.artifacts)
          await this.options.schedule(this.state.lastActivity + retentionMs);
        return null;
      }
      if (this.active) {
        await this.options.schedule(Date.now() + 1000);
        return null;
      }
      if (pending.due > Date.now()) {
        await this.options.schedule(pending.due);
        return null;
      }
      // A watchdog recovers a process/DO restart during engine I/O.
      await this.options.schedule(Date.now() + 100_000);
      pending.attempt++;
      this.state.current = { ...current, status: "running" };
      this.persist();
      const controller = new AbortController();
      const done = this.execute(
        structuredClone(current),
        pending.project,
        pending.attempt,
        controller.signal,
      );
      this.active = { id: current.id, controller, done };
      return { done };
    });
    await execution?.done;
  }

  private async execute(
    build: Build,
    project: Project,
    attempt: number,
    signal: AbortSignal,
  ) {
    try {
      await this.runEngine(build, project, attempt, signal);
    } finally {
      this.active = null;
      if (this.state.pending)
        await this.options.schedule(
          Math.max(Date.now() + 1, this.state.pending.due),
        );
      else await this.options.schedule(this.state.lastActivity + retentionMs);
    }
  }

  private async runEngine(
    build: Build,
    project: Project,
    attempt: number,
    signal: AbortSignal,
  ) {
    const started = performance.now();
    const queueWaitMs = Math.max(0, Date.now() - Date.parse(build.createdAt));
    let engineTiming = unknownEngineTiming;
    let result: Build;
    let output: Awaited<ReturnType<Engine>> | undefined;
    let cacheUsed = false;
    let cleanRetried = false;
    let logFile: HttpError["logFile"];
    let compileMs = 0;
    try {
      const manifest = this.state.artifacts;
      const cache =
        !build.clean && this.state.cacheValid && manifest?.engine === "tectonic"
          ? await readCache(this.options.store, manifest)
          : {};
      cacheUsed = Object.keys(cache).length > 0;
      const context = {
        projectId: this.options.projectId,
        jobId: build.id,
        attempt,
        plan: build.plan,
        signal,
      };
      try {
        output = await this.options.engine(project, {
          ...context,
          ...(cacheUsed ? { cache } : {}),
        });
      } catch (error) {
        if (
          !cacheUsed ||
          signal.aborted ||
          !(error instanceof HttpError) ||
          ![408, 422].includes(error.status)
        )
          throw error;
        compileMs += error.timing.compileMs ?? 0;
        cleanRetried = true;
        await this.exclusive(async () => {
          this.state.cacheValid = false;
          this.persist();
        });
        output = await this.options.engine(project, context);
      }
      engineTiming = output.timing;
      compileMs += output.timing.compileMs ?? 0;
      result = {
        ...build,
        status: "succeeded",
        log: output.log,
        sizeBytes: output.pdf.byteLength,
        artifactUrl: `/${this.pdfKey(build.id)}`,
      };
    } catch (error) {
      if (error instanceof HttpError) logFile = error.logFile;
      if (error instanceof HttpError || error instanceof EngineError)
        engineTiming = error.timing;
      result = {
        ...build,
        status: "failed",
        error:
          error instanceof HttpError
            ? error.message
            : "Compilation service failed",
        log: error instanceof HttpError ? error.log : "",
      };
      if (!signal.aborted && !(error instanceof HttpError) && attempt < 4) {
        await this.exclusive(async () => {
          if (this.state.current?.id !== build.id || !this.state.pending)
            return;
          this.state.current = { ...this.state.current, status: "queued" };
          this.state.pending.due = Date.now() + 1000;
          this.persist();
          await this.options.schedule(this.state.pending.due);
          // Queue only infrastructure/overflow work; the warm path is direct.
          await this.options.overflow();
        });
        return;
      }
    }
    const engineRequestMs = performance.now() - started;
    await this.exclusive(async () => {
      if (signal.aborted || this.state.current?.id !== build.id) return;
      const publishStarted = performance.now();
      let manifest: ArtifactManifest | null = this.state.artifacts;
      if (output && result.status === "succeeded") {
        manifest = await storeArtifacts({
          store: this.options.store,
          projectId: this.options.projectId,
          mainFile: project.mainFile,
          build: {
            id: build.id,
            revision: build.revision,
            digest: build.digest,
            builtBy: build.builtBy,
          },
          output,
        });
      } else if (result.status === "failed") {
        const path = `${project.mainFile
          .split("/")
          .at(-1)!
          .replace(/\.tex$/, "")}.log`;
        const key = `projects/${this.options.projectId}/builds/${crypto.randomUUID()}/${path}`;
        const data =
          logFile?.path === path
            ? decodeBase64(logFile.base64)
            : new TextEncoder().encode(result.log);
        await this.options.store.create(key, data);
        const file = {
          path,
          key,
          sizeBytes: data.length,
        };
        manifest = manifest
          ? {
              ...manifest,
              files: [
                ...manifest.files.filter((entry) => entry.path !== path),
                file,
              ],
            }
          : {
              id: build.id,
              revision: build.revision,
              digest: build.digest,
              builtAt: new Date().toISOString(),
              builtBy: build.builtBy,
              engine: engineTiming.engine,
              pdf: null,
              files: [file],
            };
      }
      result.timing = {
        ...engineTiming,
        plan: build.plan,
        attempt,
        artifactReused: false,
        queueWaitMs,
        inputReadMs: 0,
        engineRequestMs,
        publishMs: performance.now() - publishStarted,
        backendMs: Date.now() - Date.parse(build.createdAt),
      };
      await this.options.store.write(
        this.resultKey(build.id),
        JSON.stringify(result),
      );
      emitCompileEvent({
        event: "compile_backend",
        jobId: build.id,
        projectId: this.options.projectId,
        revision: build.revision,
        status: result.status,
        cacheUsed,
        cleanRetried,
        weightedCompileSeconds:
          engineTiming.compileMs === null
            ? null
            : (compileMs + (output ? 0 : engineTiming.compileMs)) / 1000,
        ...result.timing,
      });
      this.state.current = result;
      if (result.status === "succeeded") {
        this.state.latestBuild = result;
        this.state.cacheValid = true;
      }
      this.state.artifacts = manifest;
      if (result.status === "succeeded")
        this.state.stale = this.state.revision !== build.revision;
      this.state.lastActivity = Date.now();
      this.state.pending = null;
      this.persist();
      await this.pruneArtifacts();
    });
  }

  events(signal: AbortSignal) {
    const encoder = new TextEncoder();
    let dispose = () => {};
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          const enqueue = (text: string) => {
            if ((controller.desiredSize ?? 0) <= 0) {
              close();
              return;
            }
            controller.enqueue(encoder.encode(text));
          };
          const send = (snapshot: CoordinatorSnapshot) =>
            enqueue(`data: ${JSON.stringify(snapshot)}\n\n`);
          const ping = setInterval(() => enqueue(": heartbeat\n\n"), 15_000);
          dispose = () => {
            clearInterval(ping);
            this.listeners.delete(send);
            signal.removeEventListener("abort", close);
          };
          const close = () => {
            dispose();
            controller.close();
          };
          this.listeners.add(send);
          send(this.snapshot());
          signal.addEventListener("abort", close, { once: true });
          if (signal.aborted) close();
        },
        cancel: () => dispose(),
      },
      { highWaterMark: 32 },
    );
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  async close() {
    this.active?.controller.abort();
    await this.active?.done;
    await this.writer;
  }
}
