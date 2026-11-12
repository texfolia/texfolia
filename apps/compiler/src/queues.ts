import { z } from "zod";

import type { ProjectCoordinatorCore } from "./coordinator";
import type { Jobs } from "./jobs";
import { jobIdSchema } from "./project";
import type { planSchema } from "./telemetry";

export const compileMessageSchema = z.object({
  projectId: jobIdSchema,
  revision: z.number().int().nonnegative(),
});
export type CompileMessage = z.infer<typeof compileMessageSchema>;
export const backgroundMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recover") }),
  z.object({
    kind: z.literal("maintenance"),
    projectId: jobIdSchema,
    at: z.number().int().nonnegative(),
  }),
]);
export type BackgroundMessage = z.infer<typeof backgroundMessageSchema>;
export const deadLetterError =
  "Compilation service failed after one queue retry; moved to compile-dlq. Recompile to try again.";
export const compileQueue = (plan: z.infer<typeof planSchema>) =>
  plan === "pro" ? "compile-pro" : "compile-free";
export const backgroundDelay = (at: number) =>
  Math.min(86_400, Math.max(0, Math.ceil((at - Date.now()) / 1000)));

export function createLegacyConsumer(jobs: Jobs) {
  const running = new Map<string, Promise<boolean>>();
  return {
    async consume(id: string, attempt: number) {
      const existing = running.get(id);
      if (existing) return existing;
      const execution = jobs.consume(id, attempt);
      running.set(id, execution);
      try {
        return await execution;
      } finally {
        running.delete(id);
      }
    },
    async fail(id: string) {
      await running.get(id)?.catch(() => {});
      await jobs.fail(id);
    },
  };
}

export async function processQueueMessage(options: {
  queue: string;
  body: unknown;
  attempts: number;
  jobs: Jobs;
  legacy: Pick<Jobs, "consume" | "fail">;
  coordinator: (
    projectId: string,
  ) => Pick<ProjectCoordinatorCore, "consume" | "fail" | "maintain">;
}) {
  const { queue, body, attempts, jobs, legacy, coordinator } = options;
  if (queue === "background") {
    const task = backgroundMessageSchema.safeParse(body);
    if (!task.success) {
      console.error("Invalid background queue message", {
        queue,
        attempts,
        error: task.error,
      });
      return true;
    }
    if (task.data.kind === "recover") await jobs.recover();
    else await coordinator(task.data.projectId).maintain(task.data.at);
    return true;
  }
  const parsed = compileMessageSchema.safeParse(body);
  if (!parsed.success) {
    console.error("Invalid compile queue message", {
      queue,
      attempts,
      error: parsed.error,
    });
    return true;
  }
  const message = parsed.data;
  if (queue === "compile-dlq") {
    console.error("Compile dead-letter message", {
      ...message,
      attempts,
      error: deadLetterError,
    });
    if (message.revision === 0) await legacy.fail(message.projectId);
    else await coordinator(message.projectId).fail(message.revision);
    return true;
  }
  if (queue !== "compile-pro" && queue !== "compile-free")
    throw new Error(`Unknown compiler queue: ${queue}`);
  return message.revision === 0
    ? legacy.consume(message.projectId, attempts)
    : coordinator(message.projectId).consume(message.revision);
}
