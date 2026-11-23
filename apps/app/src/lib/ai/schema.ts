import { z } from "zod";

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

export class AiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
