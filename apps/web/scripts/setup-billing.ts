import Stripe from "stripe";

import { paidPlans } from "#/lib/billing";
import {
  isStripeAutomaticTaxEnabled,
  stripeTaxCodes,
  validateAiPrice,
  validatePlanPrice,
} from "#/lib/billing/server";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("Set STRIPE_SECRET_KEY before configuring billing");
const stripe = new Stripe(key, { apiVersion: "2026-10-28.endive" });
const automaticTax = isStripeAutomaticTaxEnabled();

for (const [plan, config] of Object.entries(paidPlans) as [
  keyof typeof paidPlans,
  (typeof paidPlans)[keyof typeof paidPlans],
][]) {
  const lookup = `texfolia_${plan}_monthly`;
  let price = (
    await stripe.prices.list({
      lookup_keys: [lookup],
      limit: 1,
      expand: ["data.product"],
    })
  ).data[0];
  if (!price) {
    const product = await stripe.products.create(
      {
        name: `Texfolia ${config.name}`,
        tax_code: stripeTaxCodes[plan],
        metadata: { plan },
      },
      { idempotencyKey: `${lookup}_product` },
    );
    price = await stripe.prices.create(
      {
        product: product.id,
        lookup_key: lookup,
        currency: "usd",
        unit_amount: config.monthlyUsd * 100,
        tax_behavior: "exclusive",
        recurring: { interval: "month", usage_type: "licensed" },
        expand: ["product"],
      },
      { idempotencyKey: `${lookup}_price` },
    );
  }
  validatePlanPrice(plan, price, { automaticTax });
  console.info(`STRIPE_${plan.toUpperCase()}_PRICE_ID=${price.id}`);
}

const aiPriceId = process.env.STRIPE_AI_PRICE_ID;
if (aiPriceId) {
  const aiPrice = await stripe.prices.retrieve(aiPriceId, {
    expand: ["product"],
  });
  validateAiPrice(aiPrice, { automaticTax });
  console.info(`STRIPE_AI_PRICE_ID=${aiPrice.id} (verified)`);
}
