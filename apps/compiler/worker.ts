import { Container, getContainer } from "@cloudflare/containers";
import { z } from "zod";

import { createApp } from "./src/api";
import { createJobs, type Engine, type ObjectStore } from "./src/jobs";
import { HttpError, jobIdSchema } from "./src/project";

interface Env {
  COMPILER: DurableObjectNamespace<TectonicContainer>;
  PDFS: R2Bucket;
  COMPILE_QUEUE: Queue<{ id: string }>;
  COMPILE_LIMIT: RateLimit;
}

export class TectonicContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
  override envVars = {
    NODE_ENV: "production",
    COMPILER_MODE: "engine",
  };

  // Keep this singleton warm even when there are no compilation requests.
  override async onActivityExpired() {}
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

const failure = z.object({ error: z.string(), log: z.string().optional() });
function containerEngine(env: Env): Engine {
  return async (project) => {
    const response = await getContainer(env.COMPILER, "compiler").fetch(
      new Request("http://container/compile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "multipart/form-data",
        },
        body: JSON.stringify(project),
        signal: AbortSignal.timeout(90_000),
      }),
    );
    if ([400, 408, 413, 422].includes(response.status)) {
      const detail = failure.parse(await response.json());
      throw new HttpError(response.status, detail.error, detail.log);
    }
    if (!response.ok) throw new Error(`TeX host returned ${response.status}`);
    const form = await response.formData();
    const pdf = form.get("pdf");
    const log = form.get("log");
    if (!(pdf instanceof Blob) || typeof log !== "string")
      throw new Error("TeX host returned an invalid result");
    return { pdf: new Uint8Array(await pdf.arrayBuffer()), log };
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
    engine: containerEngine(env),
  });

export default {
  fetch(request, env, ctx) {
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
    ctx.waitUntil(
      getContainer(env.COMPILER, "compiler").fetch("http://container/health"),
    );
  },
} satisfies ExportedHandler<Env>;
