import { jobIdSchema } from "@texfolia/contracts";
import { createDb } from "@texfolia/db";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { aiConfig } from "#/lib/ai/ai-config.server";
import { gatewayRequestCost } from "#/lib/ai/gateway";
import { reconcileAiUsage } from "#/lib/billing/server";
import { sendEmail } from "#/lib/email";
import {
  lockProject,
  shareLinkIdOf,
} from "#/lib/sharing/project-access.server";

import { liveUserHeader } from "./client";
import { createCompilerEngine, fetchCompiler } from "./compiler";
import { cacheKey, ProjectCoordinatorCore } from "./coordinator";
import { createCoordinatorApp } from "./coordinator-api";
import { reconcileProjectJob } from "./job-persistence.server";
import {
  checkCompileAdmission,
  CompileUsageCore,
  withCompileUsage,
  type Plan,
} from "./limits";
import { LiveProject } from "./live-object.server";
import { compileQueue, processQueueMessage } from "./queues";
import { artifactStore, draftSources, savedSources } from "./storage";

const usageFor = (env: Env) => (userId: string) =>
  env.COMPILE_USAGE.getByName(userId);

/** One user's rolling compile allowance. */
export class CompileUsage extends DurableObject<Env> {
  private usage: CompileUsageCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)",
    );
    this.usage = new CompileUsageCore({
      read: () =>
        [
          ...ctx.storage.sql.exec<{ value: string }>(
            "SELECT value FROM usage WHERE id = 1",
          ),
        ][0]?.value ?? null,
      write: (value) => {
        ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO usage VALUES (1, ?)",
          value,
        );
      },
    });
  }

  async check(plan: Plan) {
    return this.usage.check(plan);
  }
  async start(plan: Plan) {
    return this.usage.start(plan);
  }
  async finish(id: string, compileMs: number) {
    this.usage.finish(id, compileMs);
  }
}

/** One project's builds: admission, debounce, history, artifacts, and push. */
export class ProjectBuilds extends LiveProject {
  private core: ProjectCoordinatorCore | undefined;
  private app: ReturnType<typeof createCoordinatorApp> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS identity (projectId TEXT PRIMARY KEY)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS state_chunks (part INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
    );
  }

  private metadataVersion(): number {
    return (
      this.ctx.storage.sql
        .exec<{ version: number }>("SELECT version FROM metadata WHERE id = 1")
        .toArray()[0]?.version ?? 0
    );
  }

  private bumpMetadataVersion(): number {
    const next = this.metadataVersion() + 1;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO metadata (id, version) VALUES (1, ?)",
      next,
    );
    return next;
  }

  private metadataFrame(version = this.metadataVersion()): string {
    return JSON.stringify({ type: "metadata", version });
  }

  /** Broadcasts a metadata invalidation event to connected workspace tabs. */
  notifyMetadata(projectId: string, userIds?: readonly string[]) {
    const version = this.bumpMetadataVersion();
    this.broadcastFrame(projectId, this.metadataFrame(version), userIds);
  }

  /** Broadcasts a single-thread comment update to signed-in workspace tabs. */
  notifyComment(projectId: string, threadId: string) {
    const frame = JSON.stringify({ type: "comment", threadId });
    this.broadcastFrame(projectId, frame, undefined, (userId) =>
      userId === null ? false : shareLinkIdOf(userId) === null,
    );
  }

  private coordinator(projectId: string) {
    if (this.core) return this.core;
    const { sql } = this.ctx.storage;
    const rows = sql
      .exec<{ part: number; value: string }>(
        "SELECT part, value FROM state_chunks ORDER BY part",
      )
      .toArray();
    const savedChunks = new Map<number, string>(
      rows.map((row) => [row.part, row.value]),
    );
    let lastSaved = rows.map((row) => row.value).join("");
    let identitySaved = rows.length > 0;
    const store = artifactStore(this.env.BUILD_ARTIFACTS);
    const compile = createCompilerEngine({
      projectId,
      store,
      cacheKey: cacheKey(projectId),
      fetch: (path, init) => fetchCompiler(path, init, this.env.COMPILER),
    });
    this.core = new ProjectCoordinatorCore({
      projectId,
      saved: lastSaved || null,
      save: (value) => {
        if (value === lastSaved) return;
        const nextChunks = new Map<number, string>();
        for (let offset = 0; offset < value.length;) {
          let end = Math.min(offset + 64_000, value.length);
          const last = value.charCodeAt(end - 1);
          if (last >= 0xd800 && last <= 0xdbff) end--;
          nextChunks.set(offset, value.slice(offset, end));
          offset = end;
        }
        // Chunk snapshots below SQLite's per-row limit, writing only changed chunks.
        this.ctx.storage.transactionSync(() => {
          for (const part of savedChunks.keys()) {
            if (!nextChunks.has(part))
              sql.exec("DELETE FROM state_chunks WHERE part = ?", part);
          }
          for (const [part, chunk] of nextChunks) {
            if (savedChunks.get(part) !== chunk)
              sql.exec(
                "INSERT OR REPLACE INTO state_chunks VALUES (?, ?)",
                part,
                chunk,
              );
          }
          if (!identitySaved) {
            sql.exec("INSERT OR IGNORE INTO identity VALUES (?)", projectId);
            identitySaved = true;
          }
        });
        savedChunks.clear();
        for (const [part, chunk] of nextChunks) savedChunks.set(part, chunk);
        lastSaved = value;
      },
      publish: () => this.publish(projectId),
      reconcileJob: async (job) => {
        const connectionString = this.env.HYPERDRIVE?.connectionString;
        if (!connectionString) return;
        const db = createDb(connectionString);
        try {
          await reconcileProjectJob(db, projectId, job);
        } finally {
          await db.$client.end();
        }
      },
      schedule: (at) => this.plan("work", at),
      overflow: async (message, plan) => {
        await (
          compileQueue(plan) === "compile-pro"
            ? this.env.COMPILE_PRO
            : this.env.COMPILE_FREE
        ).send(message);
      },
      store,
      sources: {
        saved: savedSources(this.env.SOURCES),
        drafts: draftSources(this.ctx.storage),
      },
      engine: withCompileUsage(compile, usageFor(this.env)),
    });
    return this.core;
  }

  private coordinatorApp(projectId: string) {
    return (this.app ??= createCoordinatorApp(
      this.coordinator(projectId),
      (submission) =>
        checkCompileAdmission(
          submission,
          this.env.COMPILE_LIMIT,
          usageFor(this.env),
        ),
    ));
  }

  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const id = jobIdSchema.safeParse(path.split("/")[2]);
    if (!id.success)
      return Response.json({ error: "Invalid project ID" }, { status: 400 });
    if (path === `/projects/${id.data}/events`)
      return this.openSocket(request, id.data);
    if (
      request.method === "POST" &&
      path === `/projects/${id.data}/metadata-changed`
    ) {
      this.notifyMetadata(id.data);
      return new Response(null, { status: 204 });
    }
    if (
      request.method === "POST" &&
      path === `/projects/${id.data}/comment-changed`
    ) {
      const parsed = z
        .object({ threadId: z.uuid() })
        .safeParse(await request.json().catch(() => null));
      if (!parsed.success)
        return Response.json({ error: "Invalid thread ID" }, { status: 400 });
      this.notifyComment(id.data, parsed.data.threadId);
      return new Response(null, { status: 204 });
    }
    const response = await this.coordinatorApp(id.data).fetch(request);
    const viewer = request.headers.get(liveUserHeader);
    return viewer === null ? response : this.guard(response, id.data, viewer);
  }

  protected override liveFrame(projectId: string) {
    return JSON.stringify(this.coordinator(projectId).snapshot());
  }

  protected override extraLiveFrames() {
    return [this.metadataFrame()];
  }

  protected override onAccessVerified(projectId: string, userIds?: string[]) {
    this.notifyMetadata(projectId, userIds);
  }

  protected override async checkLiveAccess(projectId: string, userId: string) {
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    try {
      await db.transaction((tx) =>
        lockProject({
          tx,
          projectId,
          userId,
          access: "read",
        }),
      );
    } finally {
      await db.$client.end();
    }
  }

  protected override async work() {
    await this.project()?.wake();
  }

  // Null until the project's state is first saved, so there is nothing to do.
  private project() {
    const [identity] = this.ctx.storage.sql
      .exec<{ projectId: string }>("SELECT projectId FROM identity LIMIT 1")
      .toArray();
    return identity ? this.coordinator(identity.projectId) : null;
  }

  async consume(revision: number) {
    return (await this.project()?.consume(revision)) ?? true;
  }

  async fail(revision: number) {
    await this.project()?.fail(revision);
  }
}

/** Consumes the compile overflow, dead-letter, and background queues. */
export async function handleBuildQueue(batch: MessageBatch, env: Env) {
  for (const message of batch.messages) {
    try {
      if (
        await processQueueMessage({
          queue: batch.queue,
          body: message.body,
          attempts: message.attempts,
          coordinator: (projectId) => env.BUILDS.getByName(projectId),
          deliverEmail: (email) => sendEmail(env, email),
          reconcileAiUsage: async (runId) => {
            if (!process.env.CLOUDFLARE_AI_API_TOKEN) return;
            const db = createDb(env.HYPERDRIVE.connectionString);
            try {
              const config = aiConfig();
              const { retryAfterSeconds } = await reconcileAiUsage({
                db,
                config,
                requestCost: gatewayRequestCost(config),
                runId,
              });
              if (retryAfterSeconds !== null)
                await env.BACKGROUND.send(
                  {
                    kind: "reconcile-ai-usage",
                    ...(runId ? { runId } : {}),
                  },
                  { delaySeconds: retryAfterSeconds + 5 },
                );
            } finally {
              await db.$client.end();
            }
          },
        })
      )
        message.ack();
      else message.retry({ delaySeconds: 5 });
    } catch (error) {
      console.error("Compile queue processing failed", {
        queue: batch.queue,
        messageId: message.id,
        attempts: message.attempts,
        error,
      });
      message.retry({ delaySeconds: 5 });
    }
  }
}
