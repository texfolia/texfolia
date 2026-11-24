import {
  buildSnapshotSchema,
  failedJobSchema,
  jobIdSchema,
  planSchema,
  queuedJobSchema,
  runningJobSchema,
  succeededJobSchema,
  unknownEngineTiming,
  type ArtifactManifest,
} from "@texfolia/contracts";
import { z } from "zod";

import { createArtifactWriter, logPath, pdfPath } from "./artifacts";
import { compilePolicy, compileUserSchema } from "./limits";
import type { LivePdf } from "./live-pdf";
import { EngineError, HttpError, MissingSourceError } from "./project";
import {
  backgroundDelay,
  deadLetterError,
  type MaintenanceMessage,
  type CompileMessage,
} from "./queues";
import {
  applySnapshot,
  applySourceDelta,
  readSource,
  sourceHash,
  syncedProjectSchema,
  type SourceDelta,
  type SourceSnapshot,
  type SyncedProject,
} from "./source-sync";
import { emitCompileEvent } from "./telemetry";
import type { Engine, ObjectStore, SourceStore } from "./types";

// The coordinator stores these fields on each job beyond the shared contract.
const stored = {
  digest: z.string(),
  plan: planSchema,
  userId: compileUserSchema.optional(),
  builtBy: z.string().default("Unknown"),
  clean: z.boolean().default(false),
  submissionDigest: z.string().optional(),
};
const buildSchema = z.discriminatedUnion("status", [
  queuedJobSchema.extend(stored),
  runningJobSchema.extend(stored),
  succeededJobSchema.extend(stored),
  failedJobSchema.extend(stored),
]);
export const coordinatorSnapshotSchema = buildSnapshotSchema.extend({
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
  // Template preview projects are temporary and expire a day after last use.
  preview: z.boolean().default(false),
  pending: z
    .object({
      project: syncedProjectSchema,
      due: z.number(),
      attempt: z.number(),
      delivery: z.enum(["direct", "queued", "sent"]).default("direct"),
    })
    .nullable(),
});

export const cacheKey = (projectId: string) =>
  `projects/${projectId}/cache.tar.zst`;
const retentionMs = 30 * 24 * 60 * 60_000;
export const previewRetentionMs = 24 * 60 * 60_000;
type RunContext = {
  attempt: number;
  delivery: "direct" | "overflow";
  debounceMs: number;
};

// Every state transition of a project's builds. Engine I/O runs outside the writer so a newer edit can cancel it immediately.
export class ProjectCoordinatorCore {
  private state: z.infer<typeof savedSchema>;
  private writer = Promise.resolve();
  private submissions = 0;
  private active: {
    id: string;
    queued: boolean;
    controller: AbortController;
    done: Promise<boolean>;
  } | null = null;
  private listeners = new Set<(snapshot: CoordinatorSnapshot) => void>();
  private previews = new Map<string, (pdf: LivePdf) => void>();
  private livePdf: { id: string; pdf: LivePdf } | null = null;

  constructor(
    private options: {
      projectId: string;
      saved: string | null;
      save: (value: string) => void;
      // Hears about every state change.
      publish?: (snapshot: CoordinatorSnapshot) => void;
      schedule: (at: number) => Promise<void>;
      overflow: (
        message: CompileMessage,
        plan: z.infer<typeof planSchema>,
      ) => Promise<void>;
      background: (
        message: MaintenanceMessage,
        delaySeconds: number,
      ) => Promise<void>;
      store: ObjectStore;
      sources: SourceStore;
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
          sources: null,
          maintenanceAt: null,
          maintenanceSent: false,
          preview: false,
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
    this.options.publish?.(this.snapshot());
    for (const listener of this.listeners) listener(this.snapshot());
  }

  async submit(
    id: string,
    submission: SourceSnapshot | SourceDelta,
    submissionDigest: string,
    plan: z.infer<typeof planSchema>,
    version?: z.infer<typeof editorVersionSchema>,
    buildOptions: { clean: boolean; builtBy: string; userId?: string } = {
      clean: false,
      builtBy: "Unknown",
    },
  ) {
    this.submissions++;
    return this.exclusive(async () => {
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
              delta: submission,
              previous: this.state.sources,
              sources: this.options.sources,
              projectId: this.options.projectId,
            })
          : await applySnapshot(submission, this.options.sources);
      const digest = await sourceHash(
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
      );
      const synced = "baseRevision" in submission;
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
      this.livePdf = null;
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
        ...(synced ? { sourceRevision: project.revision } : {}),
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
        sources: synced ? project : this.state.sources,
        preview: project.preview === true,
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
    this.livePdf = null;
    await this.exclusive(async () => {
      this.state.artifacts = null;
      this.state.latestBuild = null;
      this.state.current = null;
      this.state.pending = null;
      this.state.sources = null;
      this.persist();
      this.pruneDrafts();
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
    this.pruneDrafts();
  }

  // A submission writes its drafts before the state that refers to them.
  private pruneDrafts() {
    if (this.submissions) return;
    this.options.sources.drafts.retain(
      new Set(
        [this.state.sources, this.state.pending?.project].flatMap((project) =>
          Object.values(project?.files ?? {}).map((file) => file.hash),
        ),
      ),
    );
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
    if (before - this.state.lastActivity >= this.retention()) {
      await this.exclusive(async () => {
        if (
          this.state.pending ||
          Date.now() - this.state.lastActivity < this.retention()
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
        await this.options.store.remove(key);
      }
      this.pruneDrafts();
    } else {
      await this.pruneArtifacts(before, revision);
    }
    if (this.state.maintenanceAt !== at) return;
    this.state.maintenanceAt = null;
    this.persist();
    if (this.state.current || this.state.sources || this.state.artifacts)
      await this.requestMaintenance(this.state.lastActivity + this.retention());
  }

  async fail(revision: number) {
    await this.exclusive(async () => {
      const current = this.state.current;
      if (!current || current.revision !== revision || !this.state.pending)
        return;
      this.active?.controller.abort();
      this.livePdf = null;
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
  // Pruning skips previews; retention and clear() remove them.
  private pngKey(id: string) {
    return `projects/${this.options.projectId}/previews/${id}.png`;
  }
  private retention() {
    return this.state.preview ? previewRetentionMs : retentionMs;
  }

  async get(id: string): Promise<Build | null> {
    if (this.state.current?.id === id)
      return structuredClone(this.state.current);
    const body = await this.options.store.read(this.resultKey(id));
    return body ? buildSchema.parse(await new Response(body).json()) : null;
  }

  async previewImage(id: string) {
    const build = await this.get(id);
    return build?.status === "succeeded"
      ? this.options.store.read(this.pngKey(id))
      : null;
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
    if (this.livePdf?.id === id) return pdfResponse(this.livePdf.pdf.read());
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
      this.previews.set(id, (pdf) => {
        cleanup();
        resolve(pdfResponse(pdf.read()));
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
        await this.options.schedule(
          Date.now() + compilePolicy(current.plan).timeoutMs + 120_000,
        );
      pending.attempt++;
      this.state.current = { ...current, status: "running" };
      this.persist();
      const controller = new AbortController();
      const done = this.execute(
        structuredClone(current),
        pending.project,
        {
          attempt: pending.attempt,
          // Only a queue consumer runs the overflow path. The direct path's
          // debounce is a coordinator alarm, not a queue.
          delivery: revision === undefined ? "direct" : "overflow",
          debounceMs: Math.max(
            0,
            Math.min(pending.due, Date.now()) - Date.parse(current.createdAt),
          ),
        },
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
    project: SyncedProject,
    run: RunContext,
    signal: AbortSignal,
  ) {
    try {
      return await this.runEngine(build, project, run, signal);
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
    project: SyncedProject,
    { attempt, delivery, debounceMs }: RunContext,
    signal: AbortSignal,
  ) {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    let firstPdfAt: string | undefined;
    const queueWaitMs = Math.max(0, Date.now() - Date.parse(build.createdAt));
    let engineTiming = unknownEngineTiming;
    let result: Build;
    let output: Awaited<ReturnType<Engine>> | undefined;
    let cacheUsed = false;
    let cleanRetried = false;
    let compileMs = 0;
    const createWriter = () =>
      createArtifactWriter({
        store: this.options.store,
        projectId: this.options.projectId,
        mainFile: project.mainFile,
        keys: {
          preview: this.pngKey(build.id),
          cache: cacheKey(this.options.projectId),
        },
        signal,
        onPdf: (pdf) => {
          firstPdfAt ??= new Date().toISOString();
          if (signal.aborted || this.state.current?.id !== build.id) return;
          this.livePdf = { id: build.id, pdf };
          this.previews.get(build.id)?.(pdf);
        },
      });
    let writer = createWriter();
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
        userId: build.userId,
        signal,
        clean: !cacheUsed,
        readSource: (file: SyncedProject["files"][string]) =>
          readSource(this.options.sources, file),
      };
      try {
        output = await this.options.engine(project, {
          ...context,
          artifacts: writer,
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
        await writer.settled();
        writer = createWriter();
        output = await this.options.engine(project, {
          ...context,
          clean: true,
          artifacts: writer,
        });
      }
      engineTiming = output.timing;
      cacheUsed = output.timing.cacheUsed ?? cacheUsed;
      compileMs += output.timing.compileMs ?? 0;
      result = {
        ...build,
        status: "succeeded",
        log: output.log,
        sizeBytes: output.sizeBytes,
        artifactUrl: `/${this.pdfKey(build.id)}`,
      };
    } catch (error) {
      await writer.settled();
      // Deltas can no longer build on this manifest; the next one resyncs.
      if (error instanceof MissingSourceError)
        await this.exclusive(async () => {
          if (this.state.sources?.revision === project.revision)
            this.state.sources = null;
        });
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
          this.livePdf = null;
          this.persist();
          if (this.state.pending.delivery === "direct")
            await this.dispatchOverflow();
        });
        return false;
      }
    }
    const engineRequestMs = performance.now() - started;
    const engineFinishedAt = new Date().toISOString();
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
          // Everything was streamed to storage while the engine answered.
          manifest = {
            id: build.id,
            revision: build.revision,
            digest: build.digest,
            builtBy: build.builtBy,
            files: await writer.finish(output.log),
            builtAt: new Date().toISOString(),
            engine: output.timing.engine,
            pdf: pdfPath(project.mainFile),
          };
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
        const path = logPath(project.mainFile);
        let file = await writer.saved(path);
        if (!file) {
          const key = `projects/${this.options.projectId}/builds/${crypto.randomUUID()}/${path}`;
          const data = new TextEncoder().encode(result.log);
          await this.options.store.create(key, data);
          file = { path, key, sizeBytes: data.length };
        }
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
        debounceMs,
        delivery,
        startedAt,
        ...(firstPdfAt ? { firstPdfAt } : {}),
        engineFinishedAt,
        publishedAt: new Date().toISOString(),
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
      }
      this.livePdf = null;
      this.state.artifacts = manifest;
      if (result.status === "succeeded")
        this.state.stale = this.state.revision !== build.revision;
      this.state.lastActivity = Date.now();
      this.state.pending = null;
      this.persist();
    });
    // The next build starts only when this one can no longer write.
    await writer.settled();
    return true;
  }

  async close() {
    this.active?.controller.abort();
    await this.active?.done;
    this.livePdf = null;
    await this.writer;
  }
}
