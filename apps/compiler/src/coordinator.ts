import { z } from "zod";

import {
  artifactManifestSchema,
  decodeBase64,
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
  backgroundDelay,
  deadLetterError,
  type BackgroundMessage,
  type CompileMessage,
} from "./queues";
import {
  applySourceDelta,
  readSource,
  sourceDeltaSchema,
  sourceHash,
  syncedProjectSchema,
  type SourceDelta,
  type SyncedProject,
} from "./source-sync";
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
  sourceRevision: z.number().int().nonnegative().optional(),
  submissionDigest: z.string().optional(),
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
  sources: syncedProjectSchema.nullable().default(null),
  maintenanceAt: z.number().nullable().default(null),
  maintenanceSent: z.boolean().default(false),
  pending: z
    .object({
      project: z.union([
        syncedProjectSchema,
        z.unknown().transform(parseProject),
      ]),
      due: z.number(),
      attempt: z.number(),
      delivery: z.enum(["direct", "queued", "sent"]).default("direct"),
    })
    .nullable(),
});

const retentionMs = 30 * 24 * 60 * 60_000;

// All state transitions use this implementation in both SQLite and Durable Objects.
// Engine I/O runs outside the writer so a newer edit can cancel it immediately.
export class ProjectCoordinatorCore {
  private state: z.infer<typeof savedSchema>;
  private writer = Promise.resolve();
  private submissions = 0;
  private sourceDeletes = new Map<string, Promise<void>>();
  private active: {
    id: string;
    queued: boolean;
    controller: AbortController;
    done: Promise<boolean>;
  } | null = null;
  private listeners = new Set<(snapshot: CoordinatorSnapshot) => void>();
  private previews = new Map<
    string,
    (body: ReadableStream<Uint8Array>) => void
  >();
  private pendingPreview: {
    id: string;
    body: ReadableStream<Uint8Array>;
  } | null = null;

  private discardPreview() {
    if (this.pendingPreview)
      void this.pendingPreview.body.cancel().catch(() => {});
    this.pendingPreview = null;
  }

  constructor(
    private options: {
      projectId: string;
      saved: string | null;
      save: (value: string) => void;
      schedule: (at: number) => Promise<void>;
      overflow: (
        message: CompileMessage,
        plan: z.infer<typeof planSchema>,
      ) => Promise<void>;
      background: (
        message: BackgroundMessage,
        delaySeconds: number,
      ) => Promise<void>;
      store: ObjectStore;
      engine: Engine;
      waitUntil?: (promise: Promise<void>) => void;
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
          sources: null,
          maintenanceAt: null,
          maintenanceSent: false,
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
    submission: Project | SourceDelta,
    plan: z.infer<typeof planSchema>,
    version?: z.infer<typeof editorVersionSchema>,
    buildOptions: { clean: boolean; builtBy: string } = {
      clean: false,
      builtBy: "Unknown",
    },
  ) {
    this.submissions++;
    return this.exclusive(async () => {
      const submissionDigest = await sourceHash(
        new TextEncoder().encode(JSON.stringify(submission)),
      );
      const existing = await this.get(id);
      if (existing) {
        if ((existing.submissionDigest ?? existing.digest) !== submissionDigest)
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
      const project =
        "baseRevision" in submission
          ? await applySourceDelta({
              delta: sourceDeltaSchema.parse(submission),
              previous: this.state.sources,
              store: {
                ...this.options.store,
                head: async (key) => {
                  await this.sourceDeletes.get(key);
                  return this.options.store.head(key);
                },
                create: async (key, value, metadata) => {
                  await this.sourceDeletes.get(key);
                  return this.options.store.create(key, value, metadata);
                },
              },
              projectId: this.options.projectId,
            })
          : submission;
      const digest =
        "kind" in project
          ? await sourceHash(
              new TextEncoder().encode(
                JSON.stringify({
                  mainFile: project.mainFile,
                  files: Object.fromEntries(
                    Object.keys(project.files)
                      .sort()
                      .map((path) => [path, project.files[path]!.hash]),
                  ),
                }),
              ),
            )
          : submissionDigest;
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
      this.discardPreview();
      // Persist the new revision and its wake-up before returning acceptance.
      const current: Build = {
        id,
        revision: this.state.revision + 1,
        digest,
        submissionDigest,
        status: "queued",
        createdAt: new Date().toISOString(),
        plan,
        log: "",
        ...buildOptions,
        ...("kind" in project ? { sourceRevision: project.revision } : {}),
      };
      this.state = {
        ...this.state,
        revision: current.revision,
        stale: this.state.stale || this.state.artifacts?.digest !== digest,
        cacheValid: buildOptions.clean ? false : this.state.cacheValid,
        lastActivity: Date.now(),
        current,
        pending: {
          project,
          due: Date.now() + 300,
          attempt: 0,
          delivery: "direct",
        },
        sources: "kind" in project ? project : this.state.sources,
      };
      this.persist();
      this.active?.controller.abort();
      await this.options.schedule(Date.now() + 300);
      return { ...current, supersededId };
    }).finally(() => {
      this.submissions--;
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
      if (!this.state.pending) await this.requestMaintenance();
    });
  }

  async clear() {
    this.active?.controller.abort();
    await this.active?.done;
    this.discardPreview();
    await this.exclusive(async () => {
      this.state.artifacts = null;
      this.state.latestBuild = null;
      this.state.current = null;
      this.state.pending = null;
      this.state.sources = null;
      this.persist();
      for await (const key of this.options.store.keys(
        `projects/${this.options.projectId}/`,
      ))
        await this.options.store.remove(key);
    });
  }

  private async pruneArtifacts(before: number, revision: number) {
    const keep = new Set(this.state.artifacts?.files.map((file) => file.key));
    for await (const key of this.options.store.keys(
      `projects/${this.options.projectId}/builds/`,
      before,
    ))
      if (this.state.revision !== revision || this.state.pending) return;
      else if (!keep.has(key)) await this.options.store.remove(key);
    for await (const key of this.options.store.keys(
      `projects/${this.options.projectId}/compilations/`,
      before,
    ))
      if (this.state.revision !== revision || this.state.pending) return;
      else await this.options.store.remove(key);
    const sources = new Set(
      Object.values(this.state.sources?.files ?? {}).map((file) => file.hash),
    );
    for await (const key of this.options.store.keys(
      `projects/${this.options.projectId}/source-objects/`,
      before,
    )) {
      if (
        this.submissions ||
        this.state.revision !== revision ||
        this.state.pending
      )
        return;
      if (!sources.has(key.split("/").at(-1)!))
        await this.removeBackgroundObject(key);
    }
  }

  private async removeBackgroundObject(key: string) {
    const existing = this.sourceDeletes.get(key);
    if (existing) return existing;
    const removal = this.options.store.remove(key);
    if (!key.includes("/source-objects/")) return removal;
    this.sourceDeletes.set(key, removal);
    try {
      await removal;
    } finally {
      this.sourceDeletes.delete(key);
    }
  }

  private async requestMaintenance(at = Date.now() + 1000, redeliver = false) {
    if (
      this.state.maintenanceAt === null ||
      at < this.state.maintenanceAt ||
      (!redeliver && this.state.maintenanceAt < Date.now())
    ) {
      this.state.maintenanceAt = at;
      this.state.maintenanceSent = false;
      this.persist();
    }
    if (this.state.maintenanceSent && !redeliver) return;
    const maintenanceAt = this.state.maintenanceAt;
    try {
      await this.options.background(
        {
          kind: "maintenance",
          projectId: this.options.projectId,
          at: maintenanceAt,
        },
        backgroundDelay(maintenanceAt),
      );
      if (this.state.maintenanceAt === maintenanceAt) {
        this.state.maintenanceSent = true;
        this.persist();
        if (!this.state.pending && !this.active)
          await this.options.schedule(maintenanceAt + 60_000);
      }
    } catch (error) {
      console.error("Background maintenance dispatch failed", {
        projectId: this.options.projectId,
        error,
      });
      await this.options.schedule(Date.now() + 5000);
    }
  }

  async maintain(at: number) {
    if (this.state.maintenanceAt !== at) return;
    if (at > Date.now()) {
      await this.requestMaintenance(at, true);
      return;
    }
    if (this.state.pending || this.active) {
      this.state.maintenanceAt = null;
      await this.requestMaintenance();
      return;
    }
    const before = Date.now();
    const revision = this.state.revision;
    if (before - this.state.lastActivity >= retentionMs) {
      await this.exclusive(async () => {
        if (
          this.state.pending ||
          Date.now() - this.state.lastActivity < retentionMs
        )
          return;
        this.state.artifacts = null;
        this.state.latestBuild = null;
        this.state.current = null;
        this.state.sources = null;
        this.persist();
      });
      for await (const key of this.options.store.keys(
        `projects/${this.options.projectId}/`,
        before,
      )) {
        if (
          this.submissions ||
          this.state.revision !== revision ||
          this.state.pending
        )
          break;
        await this.removeBackgroundObject(key);
      }
    } else {
      await this.pruneArtifacts(before, revision);
    }
    if (this.state.maintenanceAt !== at) return;
    this.state.maintenanceAt = null;
    this.persist();
    if (this.state.current || this.state.sources || this.state.artifacts)
      await this.requestMaintenance(this.state.lastActivity + retentionMs);
  }

  async fail(revision: number) {
    await this.exclusive(async () => {
      const current = this.state.current;
      if (!current || current.revision !== revision || !this.state.pending)
        return;
      this.active?.controller.abort();
      this.discardPreview();
      const result: Build = {
        ...current,
        status: "failed",
        error: deadLetterError,
      };
      await this.options.store.write(
        this.resultKey(current.id),
        JSON.stringify(result),
      );
      this.state.current = result;
      this.state.pending = null;
      this.persist();
      await this.requestMaintenance();
    });
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

  async preview(id: string, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const job = await this.get(id);
    if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
    const pdfResponse = (body: ReadableStream<Uint8Array>) =>
      new Response(body, {
        headers: {
          "Content-Type": "application/pdf",
          "Cache-Control": "no-store",
        },
      });
    if (this.pendingPreview?.id === id) {
      const { body } = this.pendingPreview;
      this.pendingPreview = null;
      return pdfResponse(body);
    }
    const saved = async () => {
      const body = await this.artifact(id);
      return body
        ? pdfResponse(body)
        : Response.json({ error: "PDF not found" }, { status: 404 });
    };
    if (job.status === "succeeded") return saved();
    if (job.status === "failed")
      return Response.json({ error: job.error, log: job.log }, { status: 409 });
    if (this.previews.has(id))
      return Response.json(
        { error: "PDF stream already requested" },
        { status: 409 },
      );
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.previews.delete(id);
        this.listeners.delete(check);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const check = (snapshot: CoordinatorSnapshot) => {
        const current = snapshot.current;
        if (current?.id !== id || current.status === "failed") {
          cleanup();
          resolve(
            Response.json(
              {
                error:
                  current?.id === id && current.status === "failed"
                    ? current.error
                    : "Compilation superseded",
              },
              { status: 409 },
            ),
          );
        } else if (current.status === "succeeded") {
          cleanup();
          void saved().then(resolve, reject);
        }
      };
      this.previews.set(id, (body) => {
        cleanup();
        resolve(pdfResponse(body));
      });
      this.listeners.add(check);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else check(this.snapshot());
    });
  }

  async wake() {
    await this.start();
  }

  async consume(revision: number) {
    return this.start(revision);
  }

  private async dispatchOverflow() {
    const { pending, current } = this.state;
    if (!pending || !current || pending.delivery === "sent") return;
    pending.delivery = "queued";
    this.persist();
    await this.options.schedule(Date.now() + 5000);
    await this.options.overflow(
      { projectId: this.options.projectId, revision: current.revision },
      current.plan,
    );
    pending.delivery = "sent";
    this.persist();
  }

  private async start(revision?: number): Promise<boolean> {
    const execution = await this.exclusive(async () => {
      const { pending, current } = this.state;
      if (revision !== undefined && (!current || current.revision !== revision))
        return null;
      if (!pending || !current) {
        if (
          revision === undefined &&
          (this.state.maintenanceAt !== null ||
            current ||
            this.state.artifacts ||
            this.state.sources)
        )
          await this.requestMaintenance();
        return null;
      }
      if (this.active) {
        if (
          revision !== undefined &&
          (!this.active.queued || this.active.id !== current.id)
        )
          return {
            done: this.active.done.then(
              () => this.start(revision),
              () => this.start(revision),
            ),
          };
        if (revision !== undefined)
          return {
            done: this.active.done.then(
              () =>
                this.state.current?.revision !== revision ||
                !this.state.pending,
            ),
          };
        await this.options.schedule(Date.now() + 1000);
        return null;
      }
      if (
        revision === undefined &&
        (pending.delivery !== "direct" || pending.attempt > 0)
      ) {
        await this.dispatchOverflow();
        return null;
      }
      if (
        revision !== undefined &&
        (pending.delivery === "direct" || pending.attempt >= 3)
      )
        return { done: Promise.resolve(false) };
      if (revision === undefined && pending.due > Date.now()) {
        await this.options.schedule(pending.due);
        return null;
      }
      // A watchdog recovers a process/DO restart during engine I/O.
      if (revision === undefined)
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
      this.active = {
        id: current.id,
        queued: revision !== undefined,
        controller,
        done,
      };
      return { done };
    });
    return execution ? execution.done : true;
  }

  private async execute(
    build: Build,
    project: Project | SyncedProject,
    attempt: number,
    signal: AbortSignal,
  ) {
    try {
      return await this.runEngine(build, project, attempt, signal);
    } finally {
      this.active = null;
      if (this.state.pending?.delivery === "direct")
        await this.options.schedule(
          Math.max(Date.now() + 1, this.state.pending.due),
        );
      else if (!this.state.pending) await this.requestMaintenance();
    }
  }

  private async runEngine(
    build: Build,
    project: Project | SyncedProject,
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
      cacheUsed =
        !build.clean &&
        this.state.cacheValid &&
        manifest?.engine === "tectonic";
      const context = {
        projectId: this.options.projectId,
        jobId: build.id,
        attempt,
        plan: build.plan,
        signal,
        clean: !cacheUsed,
        readSource: (file: SyncedProject["files"][string]) =>
          readSource(this.options.store, this.options.projectId, file),
        onPdf: (body: ReadableStream<Uint8Array>) => {
          const preview =
            !signal.aborted && this.state.current?.id === build.id
              ? this.previews.get(build.id)
              : undefined;
          if (preview) preview(body);
          else if (!signal.aborted && this.state.current?.id === build.id) {
            this.discardPreview();
            const [pending, drain] = body.tee();
            this.pendingPreview = { id: build.id, body: pending };
            void drain
              .pipeTo(new WritableStream({ write() {} }))
              .catch(() => {});
          } else void body.cancel().catch(() => {});
        },
      };
      try {
        output = await this.options.engine(project, {
          ...context,
        });
      } catch (error) {
        if (
          !cacheUsed ||
          signal.aborted ||
          !(error instanceof HttpError) ||
          error.timing.cacheUsed === false ||
          ![408, 422].includes(error.status)
        )
          throw error;
        compileMs += error.timing.compileMs ?? 0;
        cleanRetried = true;
        await this.exclusive(async () => {
          this.state.cacheValid = false;
          this.persist();
        });
        output = await this.options.engine(project, {
          ...context,
          clean: true,
        });
      }
      engineTiming = output.timing;
      cacheUsed = output.timing.cacheUsed ?? cacheUsed;
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
      if (!signal.aborted && !(error instanceof HttpError)) {
        console.error("Compile infrastructure failure", {
          projectId: this.options.projectId,
          jobId: build.id,
          revision: build.revision,
          attempt,
          error,
        });
        await this.exclusive(async () => {
          if (this.state.current?.id !== build.id || !this.state.pending)
            return;
          this.state.current = { ...this.state.current, status: "queued" };
          this.discardPreview();
          this.persist();
          if (this.state.pending.delivery === "direct")
            await this.dispatchOverflow();
        });
        return false;
      }
    }
    const engineRequestMs = performance.now() - started;
    await this.exclusive(async () => {
      if (
        signal.aborted ||
        this.state.current?.id !== build.id ||
        !this.state.pending
      )
        return;
      const publishStarted = performance.now();
      let manifest: ArtifactManifest | null = this.state.artifacts;
      if (output && result.status === "succeeded") {
        try {
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
          if (output.cacheArchive)
            await this.options.store.write(
              `projects/${this.options.projectId}/cache.tar.zst`,
              new Uint8Array(await output.cacheArchive.arrayBuffer()),
            );
        } catch (error) {
          console.error("Build artifact persistence failed", {
            jobId: build.id,
            error,
          });
          manifest = this.state.artifacts;
          result = {
            ...build,
            status: "failed",
            log: output.log,
            error:
              "PDF compiled but could not be saved. Recompile to try again.",
          };
        }
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
      try {
        await this.options.store.write(
          this.resultKey(build.id),
          JSON.stringify(result),
        );
      } catch (error) {
        console.error("Build result persistence failed", {
          jobId: build.id,
          error,
        });
        manifest = this.state.artifacts;
        result = {
          ...build,
          status: "failed",
          log: result.log,
          timing: result.timing,
          error: "PDF compiled but could not be saved. Recompile to try again.",
        };
      }
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
        this.discardPreview();
      }
      this.state.artifacts = manifest;
      if (result.status === "succeeded")
        this.state.stale = this.state.revision !== build.revision;
      this.state.lastActivity = Date.now();
      this.state.pending = null;
      this.persist();
    });
    return true;
  }

  events(signal: AbortSignal) {
    const prewarm = this.options.engine.prewarm?.().catch((error) => {
      console.warn("Editor container prewarm failed", {
        projectId: this.options.projectId,
        error,
      });
    });
    if (prewarm) this.options.waitUntil?.(prewarm);
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
    this.discardPreview();
    await this.writer;
  }
}
