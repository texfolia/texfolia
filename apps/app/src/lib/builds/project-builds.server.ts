import { jobIdSchema } from "@texfolia/contracts";
import { createDb } from "@texfolia/db";
import { DurableObject } from "cloudflare:workers";

import { sendEmail } from "#/lib/email";
import { lockProject } from "#/lib/sharing/project-access.server";

import { liveUserHeader } from "./client";
import { createCompilerEngine, fetchCompiler } from "./compiler";
import { cacheKey, ProjectCoordinatorCore } from "./coordinator";
import { createCoordinatorApp } from "./coordinator-api";
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS identity (projectId TEXT PRIMARY KEY)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS state_chunks (part INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  private coordinator(projectId: string) {
    if (this.core) return this.core;
    const { sql } = this.ctx.storage;
    const saved = [
      ...sql.exec<{ value: string }>(
        "SELECT value FROM state_chunks ORDER BY part",
      ),
    ]
      .map((row) => row.value)
      .join("");
    const store = artifactStore(this.env.BUILD_ARTIFACTS);
    const compile = createCompilerEngine({
      projectId,
      store,
      cacheKey: cacheKey(projectId),
      fetch: (path, init) => fetchCompiler(path, init, this.env.COMPILER),
    });
    this.core = new ProjectCoordinatorCore({
      projectId,
      saved: saved || null,
      save: (value) => {
        // Chunk snapshots below SQLite's per-row limit.
        this.ctx.storage.transactionSync(() => {
          sql.exec("DELETE FROM state_chunks");
          for (let offset = 0; offset < value.length;) {
            let end = Math.min(offset + 64_000, value.length);
            const last = value.charCodeAt(end - 1);
            if (last >= 0xd800 && last <= 0xdbff) end--;
            sql.exec(
              "INSERT INTO state_chunks VALUES (?, ?)",
              offset,
              value.slice(offset, end),
            );
            offset = end;
          }
          sql.exec("INSERT OR IGNORE INTO identity VALUES (?)", projectId);
        });
      },
      publish: () => this.publish(projectId),
      schedule: (at) => this.plan("work", at),
      overflow: async (message, plan) => {
        await (
          compileQueue(plan) === "compile-pro"
            ? this.env.COMPILE_PRO
            : this.env.COMPILE_FREE
        ).send(message);
      },
      background: async (message, delaySeconds) => {
        await this.env.BACKGROUND.send(message, { delaySeconds });
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

  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const id = jobIdSchema.safeParse(path.split("/")[2]);
    if (!id.success)
      return Response.json({ error: "Invalid project ID" }, { status: 400 });
    if (path === `/projects/${id.data}/events`)
      return this.openSocket(request, id.data);
    const response = await createCoordinatorApp(
      this.coordinator(id.data),
      (submission) =>
        checkCompileAdmission(
          submission,
          this.env.COMPILE_LIMIT,
          usageFor(this.env),
        ),
    ).fetch(request);
    const viewer = request.headers.get(liveUserHeader);
    return viewer === null ? response : this.guard(response, id.data, viewer);
  }

  protected override liveFrame(projectId: string) {
    return JSON.stringify(this.coordinator(projectId).snapshot());
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

  async maintain(at: number) {
    await this.project()?.maintain(at);
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
