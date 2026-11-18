import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { createApp } from "./src/api";
import { ProjectCoordinatorCore } from "./src/coordinator";
import { createCoordinatorApp } from "./src/coordinator-api";
import { createEngineClient } from "./src/engine";
import { createJobs, type ObjectStore } from "./src/jobs";
import {
  CompileUsageCore,
  checkCompileAdmission,
  compilePolicy,
  withCompileUsage,
} from "./src/limits";
import { PoolCore, poolClaimSchema, type PoolClaim } from "./src/pool";
import { createPooledEngine } from "./src/pooled-engine";
import { jobIdSchema } from "./src/project";
import {
  compileQueue,
  createLegacyConsumer,
  processQueueMessage,
} from "./src/queues";
import { planSchema } from "./src/telemetry";

export class TectonicContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter: string | number = "10m";

  override async fetch(request: Request) {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === "/compile"
    ) {
      const plan = planSchema
        .catch("unknown")
        .parse(request.headers.get("X-Compile-Plan"));
      this.sleepAfter = compilePolicy(plan).idleMs / 1000;
      await this.ctx.storage.put("compilePlan", plan);
    } else {
      this.sleepAfter =
        compilePolicy(
          (await this.ctx.storage.get<"free" | "pro" | "team" | "unknown">(
            "compilePlan",
          )) ?? "free",
        ).idleMs / 1000;
    }
    return super.fetch(request);
  }
}

export class UserCompileUsage extends DurableObject<Env> {
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

  async check(plan: z.infer<typeof planSchema>) {
    return this.usage.check(plan);
  }
  async start(plan: z.infer<typeof planSchema>) {
    return this.usage.start(plan);
  }
  async finish(id: string, compileMs: number) {
    this.usage.finish(id, compileMs);
  }
}

const usageFor = (env: Env) => (userId: string) =>
  env.COMPILE_USAGE.getByName(userId);
const admit = (env: Env) => (request: Request) =>
  checkCompileAdmission(request, env.COMPILE_LIMIT, usageFor(env));

export class PoolManager extends DurableObject<Env> {
  private pool: PoolCore;
  private pendingAssignment: { key: string; claim: PoolClaim } | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pool_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const saved = ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM pool_state WHERE id = 1")
      .toArray()[0];
    this.pool = new PoolCore({
      saved: saved?.value ?? null,
      save: (value) =>
        ctx.storage.transactionSync(() => {
          if (this.pendingAssignment) {
            ctx.storage.sql.exec(
              "INSERT INTO claims VALUES (?, ?)",
              this.pendingAssignment.key,
              JSON.stringify(this.pendingAssignment.claim),
            );
            this.pendingAssignment = undefined;
          }
          ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO pool_state VALUES (1, ?)",
            value,
          );
        }),
      lookup: (key) => {
        const row = ctx.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM claims WHERE key = ?",
            key,
          )
          .toArray()[0];
        return row ? poolClaimSchema.parse(JSON.parse(row.value)) : undefined;
      },
      assign: (key, claim) => {
        this.pendingAssignment = { key, claim };
      },
      start: async (name) => {
        const container = getContainer(env.COMPILER, name);
        await container.startAndWaitForPorts();
        const response = await container.fetch(
          new Request("http://container/health"),
        );
        await response.body?.cancel();
        if (!response.ok) throw new Error("Spare health check failed");
      },
      stop: async (name) => {
        await getContainer(env.COMPILER, name).destroy();
      },
      reset: async (name, token) => {
        const container = getContainer(env.COMPILER, name);
        const response = await container.fetch(
          new Request("http://container/lease", {
            method: "DELETE",
            headers: { "X-Container-Lease": token },
            signal: AbortSignal.timeout(90_000),
          }),
        );
        await response.body?.cancel();
        if (!response.ok)
          throw new Error(`Container reset failed (${response.status})`);
      },
      now: Date.now,
      pause: () => new Promise((resolve) => setTimeout(resolve, 25)),
    });
  }

  async ensure() {
    const at = Date.now() + 100;
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > at)
      await this.ctx.storage.setAlarm(at);
  }

  async claim(
    projectId: string,
    plan: z.infer<typeof planSchema>,
    claimId: string,
  ) {
    jobIdSchema.parse(projectId);
    jobIdSchema.parse(claimId);
    planSchema.parse(plan);
    try {
      return await this.pool.claim(projectId, plan, claimId);
    } finally {
      // Schedule after the lease exists so an idle alarm cannot stop before it.
      await this.ensure();
    }
  }

  async release(projectId: string, claimId: string) {
    jobIdSchema.parse(projectId);
    jobIdSchema.parse(claimId);
    await this.ensure();
    await this.pool.release(projectId, claimId);
  }

  async touch() {
    this.pool.touch();
  }

  override async alarm() {
    // Schedule first so failures cannot leave the pool permanently asleep.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    await this.pool.maintain();
    console.info({ event: "compile_pool", ...this.pool.snapshot() });
    // Nothing is running or owed cleanup. The next claim schedules maintenance again.
    if (this.pool.idle()) await this.ctx.storage.deleteAlarm();
  }
}

export class ProjectCoordinator extends DurableObject<Env> {
  private core: ProjectCoordinatorCore | undefined;
  private legacy: ReturnType<typeof createLegacyConsumer> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS identity (projectId TEXT PRIMARY KEY)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS state_chunks (part INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  private async retireLegacyAssignment() {
    const legacy = this.ctx.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'container_assignment'",
      )
      .toArray()[0];
    if (!legacy) return;
    const assignment = this.ctx.storage.sql
      .exec<{ name: string | null }>(
        "SELECT name FROM container_assignment WHERE id = 1",
      )
      .toArray()[0];
    // Free this project's old instance before claiming against the same 20-instance cap.
    if (assignment?.name)
      await getContainer(this.env.COMPILER, assignment.name).destroy();
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS container_assignment");
  }

  private coordinator(projectId: string) {
    if (this.core) return this.core;
    const saved = [
      ...this.ctx.storage.sql.exec<{ value: string }>(
        "SELECT value FROM state_chunks ORDER BY part",
      ),
    ]
      .map((row) => row.value)
      .join("");
    const pool = this.env.POOL.getByName("global");
    const compile = createPooledEngine({
      projectId,
      store: r2Store(this.env.PDFS),
      claim: async (plan, claimId) => {
        await this.retireLegacyAssignment();
        return pool.claim(projectId, plan, claimId);
      },
      release: (claimId) => pool.release(projectId, claimId),
      fetch: (name, request) =>
        getContainer(this.env.COMPILER, name).fetch(request),
      discard: (name) => getContainer(this.env.COMPILER, name).destroy(),
      prewarm: async () => {
        await this.retireLegacyAssignment();
        await pool.touch();
      },
    });
    this.core = new ProjectCoordinatorCore({
      projectId,
      saved: saved || null,
      save: (value) => {
        // Chunk snapshots below SQLite's per-row limit, including binary assets.
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("DELETE FROM state_chunks");
          for (let offset = 0; offset < value.length;) {
            let end = Math.min(offset + 64_000, value.length);
            const last = value.charCodeAt(end - 1);
            if (last >= 0xd800 && last <= 0xdbff) end--;
            this.ctx.storage.sql.exec(
              "INSERT INTO state_chunks VALUES (?, ?)",
              offset,
              value.slice(offset, end),
            );
            offset = end;
          }
          this.ctx.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS identity (projectId TEXT PRIMARY KEY)",
          );
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO identity VALUES (?)",
            projectId,
          );
        });
      },
      schedule: (at) => this.ctx.storage.setAlarm(at),
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
      store: r2Store(this.env.PDFS),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      engine: withCompileUsage(compile, usageFor(this.env)),
    });
    return this.core;
  }

  override fetch(request: Request) {
    const id = jobIdSchema.parse(new URL(request.url).pathname.split("/")[2]);
    return createCoordinatorApp(this.coordinator(id), admit(this.env)).fetch(
      request,
    );
  }

  override async alarm() {
    await this.run();
  }

  private project() {
    const projectId = this.ctx.storage.sql
      .exec<{ projectId: string }>("SELECT projectId FROM identity LIMIT 1")
      .one().projectId;
    return this.coordinator(projectId);
  }

  async run() {
    await this.project().wake();
  }

  async consume(revision: number) {
    return this.project().consume(revision);
  }

  async fail(revision: number) {
    await this.project().fail(revision);
  }

  async maintain(at: number) {
    await this.project().maintain(at);
  }

  async consumeLegacy(id: string, attempt: number) {
    this.legacy ??= createLegacyConsumer(jobsFor(this.env));
    return this.legacy.consume(id, attempt);
  }

  async failLegacy(id: string) {
    this.legacy ??= createLegacyConsumer(jobsFor(this.env));
    await this.legacy.fail(id);
  }
}

function r2Store(bucket: R2Bucket): ObjectStore {
  return {
    async read(key) {
      const object = await bucket.get(key);
      return object?.body ?? null;
    },
    async head(key) {
      const object = await bucket.head(key);
      return object
        ? { size: object.size, metadata: object.customMetadata?.job }
        : null;
    },
    async create(key, value, metadata) {
      return (
        (await bucket.put(
          key,
          typeof value === "string" ? value : new Uint8Array(value),
          {
            onlyIf: new Headers({ "If-None-Match": "*" }),
            customMetadata: metadata ? { job: metadata } : undefined,
            httpMetadata: key.endsWith(".pdf")
              ? { contentType: "application/pdf" }
              : undefined,
          },
        )) !== null
      );
    },
    async write(key, value) {
      await bucket.put(key, value);
    },
    remove: (key) => bucket.delete(key),
    async *keys(prefix, before) {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        for (const object of page.objects)
          if (before === undefined || object.uploaded.getTime() < before)
            yield object.key;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },
  };
}

const app = createApp();
const jobsFor = (env: Env) =>
  createJobs({
    store: r2Store(env.PDFS),
    queue: {
      async send({ id }, plan) {
        await (
          compileQueue(plan) === "compile-pro"
            ? env.COMPILE_PRO
            : env.COMPILE_FREE
        ).send({ projectId: id, revision: 0 });
      },
    },
    engine: withCompileUsage(
      (project, context) =>
        createEngineClient((request) =>
          getContainer(env.COMPILER, `legacy:${context.jobId}`).fetch(request),
        )(project, { ...context, projectId: context.jobId }),
      usageFor(env),
    ),
  });

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/projects/")) {
      const id = jobIdSchema.safeParse(path.split("/")[2]);
      if (!id.success)
        return Response.json({ error: "Invalid project ID" }, { status: 400 });
      return env.PROJECTS.getByName(id.data).fetch(request);
    }
    return app.fetch(
      request,
      {
        jobs: jobsFor(env),
        admit: admit(env),
      },
      ctx,
    );
  },
  async queue(batch, env) {
    const jobs = jobsFor(env);
    for (const message of batch.messages) {
      try {
        if (
          await processQueueMessage({
            queue: batch.queue,
            body: message.body,
            attempts: message.attempts,
            jobs,
            legacy: {
              consume: (id, attempt) =>
                env.PROJECTS.getByName(`legacy:${id}`).consumeLegacy(
                  id,
                  attempt,
                ),
              fail: (id) =>
                env.PROJECTS.getByName(`legacy:${id}`).failLegacy(id),
            },
            coordinator: (projectId) => env.PROJECTS.getByName(projectId),
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
  },
  async scheduled(_event, env, ctx) {
    // Job recovery only. Waking the pool here would keep it from scaling to zero.
    ctx.waitUntil(
      env.BACKGROUND.send({ kind: "recover" }, { delaySeconds: 5 }),
    );
  },
} satisfies ExportedHandler<Env>;
