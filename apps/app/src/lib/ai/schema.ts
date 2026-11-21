import { z } from "zod";

export const nanoDollars = 1_000_000_000;
export const maxOutputTokens = 2048;
export const aiPreferencesSchema = z.object({
  defaultModel: z.string().min(1).max(200).nullable(),
  monthlyCapDollars: z.number().finite().min(0).max(10_000).multipleOf(0.01),
});
export const aiModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  inputPrice: z.number().finite().nonnegative(),
  outputPrice: z.number().finite().nonnegative(),
});
export type AiModel = z.infer<typeof aiModelSchema>;
export const aiConfigurationSchema = z.object({
  enabled: z.boolean(),
  models: z.array(aiModelSchema),
  defaultModel: z.string().nullable(),
  monthlyCapDollars: z.number(),
  spentDollars: z.number(),
  reservedDollars: z.number(),
  needsReview: z.boolean(),
  pendingRequests: z.number().int().nonnegative(),
});
export type AiConfiguration = z.infer<typeof aiConfigurationSchema>;

export function markedUpNanos(base: number, percent = 20) {
  if (
    !Number.isSafeInteger(base) ||
    base < 0 ||
    !Number.isInteger(percent) ||
    percent < 0
  )
    throw new Error("Invalid AI cost");
  const amount = Math.ceil((base * (100 + percent)) / 100);
  if (!Number.isSafeInteger(amount))
    throw new Error("AI cost exceeds supported precision");
  return amount;
}

export class AiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
