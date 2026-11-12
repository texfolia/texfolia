import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { createApp } from "./src/api";
import { ProjectCoordinatorCore } from "./src/coordinator";
import { createCoordinatorApp } from "./src/coordinator-api";
import { createEngineClient } from "./src/engine";
import { createJobs, type Engine, type ObjectStore } from "./src/jobs";
import {
  CompileUsageCore,
  checkCompileAdmission,
  compilePolicy,
  withCompileUsage,
} from "./src/limits";
import { PoolCore, poolClaimSchema, type PoolClaim } from "./src/pool";
import { jobIdSchema } from "./src/project";
import { createProjectEngineClient } from "./src/project-engine";
import {
  compileQueue,
  createLegacyConsumer,
  processQueueMessage,
} from "./src/queues";
import { planSchema, emitCompileEvent } from "./src/telemetry";

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
        await getContainer(env.COMPILER, name).stop();
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
    await this.ensure();
    return this.pool.claim(projectId, plan, claimId);
  }

  override async alarm() {
    // Schedule first so failures cannot leave the pool permanently asleep.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    await this.pool.maintain();
    console.info({ event: "compile_pool", ...this.pool.snapshot() });
  }
}

export class ProjectCoordinator extends DurableObject<Env> {
  private core: ProjectCoordinatorCore | undefined;
  private legacy: ReturnType<typeof createLegacyConsumer> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS container_assignment (id INTEGER PRIMARY KEY, claimId TEXT NOT NULL, name TEXT)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS identity (projectId TEXT PRIMARY KEY)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS state_chunks (part INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
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
    let engine:
      | { name: string; compile: ReturnType<typeof createProjectEngineClient> }
      | undefined;
    let selecting: ReturnType<typeof selectEngine> | undefined;
    const selectEngine = async (plan: z.infer<typeof planSchema>) => {
      let assignment = this.ctx.storage.sql
        .exec<{ claimId: string; name: string | null }>(
          "SELECT claimId, name FROM container_assignment WHERE id = 1",
        )
        .toArray()[0];
      let outcome: "hit" | "miss" | "reused" | "error" = "reused";
      if (assignment?.name) {
        const state = await getContainer(
          this.env.COMPILER,
          assignment.name,
        ).getState();
        if (state.status !== "running") assignment = undefined;
      }
      if (!assignment) {
        assignment = { claimId: crypto.randomUUID(), name: null };
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO container_assignment VALUES (1, ?, NULL)",
          assignment.claimId,
        );
      }
      let name = assignment.name;
      if (!name) {
        try {
          const claim = await this.env.POOL.getByName("global").claim(
            projectId,
            plan,
            assignment.claimId,
          );
          name = claim.container;
          outcome = claim.outcome;
        } catch (error) {
          console.error("Container pool claim failed", { projectId, error });
          name = `project:${projectId}:${assignment.claimId}`;
          outcome = "error";
        }
        this.ctx.storage.sql.exec(
          "UPDATE container_assignment SET name = ? WHERE id = 1",
          name,
        );
      }
      if (engine?.name !== name) {
        const container = getContainer(this.env.COMPILER, name);
        engine = {
          name,
          compile: createProjectEngineClient({
            projectId,
            store: r2Store(this.env.PDFS),
            fetch: (request) => container.fetch(request),
          }),
        };
      }
      return { ...engine, outcome };
    };
    const assignedEngine = (plan: z.infer<typeof planSchema>) => {
      if (selecting) return selecting;
      const pending = selectEngine(plan).finally(() => {
        selecting = undefined;
      });
      selecting = pending;
      return pending;
    };
    let prewarming: ReturnType<typeof selectEngine> | undefined;
    const compile: Engine = async (project, context) => {
      const selected = await (prewarming ?? assignedEngine(context.plan));
      emitCompileEvent({
        event: "compile_pool_claim",
        jobId: context.jobId,
        projectId,
        plan: context.plan,
        outcome: selected.outcome,
        container: selected.name,
      });
      return selected.compile(project, context);
    };
    compile.prewarm = async () => {
      const pending = prewarming ?? assignedEngine("unknown");
      prewarming = pending;
      try {
        const selected = await pending;
        await selected.compile.prewarm?.();
      } finally {
        if (prewarming === pending) prewarming = undefined;
      }
    };
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
    ctx.waitUntil(
      Promise.all([
        env.BACKGROUND.send({ kind: "recover" }, { delaySeconds: 5 }),
        env.POOL.getByName("global").ensure(),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
