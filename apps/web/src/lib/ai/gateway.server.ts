import { z } from "zod";

import { AiError, type AiModel } from "./schema";

export type AiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function aiConfig() {
  const parsed = z
    .object({
      accountId: z.string().regex(/^[a-f0-9]{32}$/),
      gatewayId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      apiToken: z.string().min(1),
      stripeKey: z.string().min(1),
      meterEventName: z.string().min(1),
      priceId: z.string().startsWith("price_"),
    })
    .safeParse({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      gatewayId: process.env.CLOUDFLARE_AI_GATEWAY_ID,
      apiToken: process.env.CLOUDFLARE_AI_API_TOKEN,
      stripeKey: process.env.STRIPE_SECRET_KEY,
      meterEventName: process.env.STRIPE_AI_METER_EVENT_NAME,
      priceId: process.env.STRIPE_AI_PRICE_ID,
    });
  if (!parsed.success)
    throw new AiError("The assistant is not configured. Try again later.", 503);
  return parsed.data;
}
export type AiConfig = ReturnType<typeof aiConfig>;

export async function cloudflareJson(
  config: Pick<AiConfig, "accountId" | "apiToken">,
  path: string,
  fetcher: AiFetch = fetch,
) {
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/${path}`,
    {
      headers: { Authorization: `Bearer ${config.apiToken}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`AI Gateway API returned ${response.status}`);
  return response.json();
}
const price = z
  .union([
    z.number(),
    z.string().regex(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/),
  ])
  .transform((value) => Number(value))
  .pipe(z.number().finite().nonnegative());
const catalogModel = z.object({
  id: z.string(),
  name: z.string(),
  pricing: z.object({
    prompt: price,
    completion: price,
    request: price.optional().default(0),
  }),
  supported_parameters: z.array(z.string()),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
});

// Cloudflare exposes the catalog in the documented OpenRouter marketplace format.
export async function gatewayModels(
  config: AiConfig,
  fetcher: AiFetch = fetch,
): Promise<AiModel[]> {
  const models: AiModel[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const json = await cloudflareJson(
      config,
      `ai/models/search?format=openrouter&per_page=100&page=${page}`,
      fetcher,
    );
    const result = z.object({ data: z.array(z.unknown()) }).parse(json);
    let newModels = 0;
    for (const item of result.data) {
      const parsed = catalogModel.safeParse(item);
      if (!parsed.success) continue;
      const model = parsed.data;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      newModels++;
      if (
        !model.supported_parameters.includes("tools") ||
        !model.supported_parameters.includes("max_tokens") ||
        model.pricing.request !== 0 ||
        !model.architecture.input_modalities.includes("text") ||
        !model.architecture.output_modalities.includes("text")
      )
        continue;
      models.push({
        id: model.id,
        name: model.name,
        inputPrice: model.pricing.prompt,
        outputPrice: model.pricing.completion,
      });
    }
    if (result.data.length < 100 || newModels === 0)
      return models.sort((a, b) => a.name.localeCompare(b.name));
  }
  throw new Error("AI model catalog pagination limit exceeded");
}

export const gatewayLogSchema = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.string(),
    model: z.string(),
    cost: z.number().finite().nonnegative().nullish(),
    tokens_in: z.number().int().nonnegative().optional(),
    tokens_out: z.number().int().nonnegative().optional(),
  }),
});
