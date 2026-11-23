import { parseAiConfig } from "@texfolia/ai/gateway";

/** The assistant's AI Gateway and usage-meter settings. Throws when unset. */
export function aiConfig() {
  return parseAiConfig({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    gatewayId: process.env.CLOUDFLARE_AI_GATEWAY_ID,
    apiToken: process.env.CLOUDFLARE_AI_API_TOKEN,
    stripeKey: process.env.STRIPE_SECRET_KEY,
    meterEventName: process.env.STRIPE_AI_METER_EVENT_NAME,
    priceId: process.env.STRIPE_AI_PRICE_ID,
  });
}
