import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { createApp } from "./src/api";
import { ProjectCoordinatorCore } from "./src/coordinator";
import { createCoordinatorApp } from "./src/coordinator-api";
import { createEngineClient } from "./src/engine";
import { createJobs, type ObjectStore } from "./src/jobs";
import { jobIdSchema } from "./src/project";

export class TectonicContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
}

export class ProjectCoordinator extends DurableObject<Env> {
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
    const saved = [
      ...this.ctx.storage.sql.exec<{ value: string }>(
        "SELECT value FROM state_chunks ORDER BY part",
      ),
    ]
      .map((row) => row.value)
      .join("");
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
      overflow: async () => {
        await this.env.COMPILE_QUEUE.send({ projectId });
      },
      store: r2Store(this.env.PDFS),
      engine: createEngineClient((request) =>
        getContainer(this.env.COMPILER, `project:${projectId}`).fetch(request),
      ),
    });
    return this.core;
  }

  override fetch(request: Request) {
    const id = jobIdSchema.parse(new URL(request.url).pathname.split("/")[2]);
    return createCoordinatorApp(this.coordinator(id)).fetch(request);
  }

  override async alarm() {
    await this.run();
  }

  async run() {
    const projectId = this.ctx.storage.sql
      .exec<{ projectId: string }>("SELECT projectId FROM identity LIMIT 1")
      .one().projectId;
    await this.coordinator(projectId).wake();
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
    async *keys(prefix) {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        for (const object of page.objects) yield object.key;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },
  };
}

const app = createApp();
const queueMessage = z.object({ id: jobIdSchema });
const jobsFor = (env: Env) =>
  createJobs({
    store: r2Store(env.PDFS),
    queue: {
      async send(message) {
        await env.COMPILE_QUEUE.send(message);
      },
    },
    engine: createEngineClient((request) =>
      getContainer(env.COMPILER, "compiler").fetch(request),
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
        limiter: env.COMPILE_LIMIT,
      },
      ctx,
    );
  },
  async queue(batch, env) {
    const jobs = jobsFor(env);
    for (const message of batch.messages) {
      const overflow = z
        .object({ projectId: jobIdSchema })
        .safeParse(message.body);
      if (overflow.success) {
        try {
          await env.PROJECTS.getByName(overflow.data.projectId).run();
          message.ack();
        } catch {
          message.retry({ delaySeconds: 5 });
        }
        continue;
      }
      const job = queueMessage.safeParse(message.body);
      if (!job.success) {
        console.error("Invalid compile queue message", {
          messageId: message.id,
        });
        message.ack();
        continue;
      }
      try {
        if (await jobs.consume(job.data.id, message.attempts)) message.ack();
        else message.retry({ delaySeconds: 5 });
      } catch (error) {
        console.error("Compile queue processing failed", {
          jobId: job.data.id,
          error,
        });
        message.retry({ delaySeconds: 5 });
      }
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(jobsFor(env).recover());
  },
} satisfies ExportedHandler<Env>;
