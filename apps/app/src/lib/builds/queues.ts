import { jobIdSchema, type planSchema } from "@texfolia/contracts";
import { z } from "zod";

import { emailJobSchema, type DeliverEmail } from "#/lib/email";

import type { ProjectCoordinatorCore } from "./coordinator";
import { isPaid } from "./limits";

const compileMessageSchema = z.object({
  projectId: jobIdSchema,
  revision: z.number().int().positive(),
});
export type CompileMessage = z.infer<typeof compileMessageSchema>;
const maintenanceMessageSchema = z.object({
  kind: z.literal("maintenance"),
  projectId: jobIdSchema,
  at: z.number().int().nonnegative(),
});
export type MaintenanceMessage = z.infer<typeof maintenanceMessageSchema>;
const reconcileAiUsageMessageSchema = z.object({
  kind: z.literal("reconcile-ai-usage"),
  runId: z.uuid().optional(),
});
export type ReconcileAiUsageMessage = z.infer<
  typeof reconcileAiUsageMessageSchema
>;
const backgroundMessageSchema = z.discriminatedUnion("kind", [
  maintenanceMessageSchema,
  emailJobSchema,
  reconcileAiUsageMessageSchema,
]);
export const deadLetterError =
  "Compilation service failed after one queue retry; moved to compile-dlq. Recompile to try again.";
export const compileQueue = (plan: z.infer<typeof planSchema>) =>
  isPaid(plan) ? "compile-pro" : "compile-free";
export const backgroundDelay = (at: number) =>
  Math.min(86_400, Math.max(0, Math.ceil((at - Date.now()) / 1000)));

export async function processQueueMessage(options: {
  queue: string;
  body: unknown;
  attempts: number;
  coordinator: (
    projectId: string,
  ) => Pick<ProjectCoordinatorCore, "consume" | "fail" | "maintain">;
  deliverEmail: DeliverEmail;
  reconcileAiUsage?: (runId?: string) => Promise<void>;
}) {
  const { body, attempts, coordinator } = options;
  const queue = options.queue.replace(/-local$/, "");
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
    // A failed delivery throws, so the queue retries it.
    if (task.data.kind === "email")
      await options.deliverEmail(task.data.message);
    else if (task.data.kind === "reconcile-ai-usage")
      await options.reconcileAiUsage?.(task.data.runId);
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
    await coordinator(message.projectId).fail(message.revision);
    return true;
  }
  if (queue !== "compile-pro" && queue !== "compile-free")
    throw new Error(`Unknown compiler queue: ${queue}`);
  return coordinator(message.projectId).consume(message.revision);
}
