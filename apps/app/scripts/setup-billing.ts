import { paidPlans } from "@texfolia/billing";
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("Set STRIPE_SECRET_KEY before configuring billing");
const stripe = new Stripe(key, { apiVersion: "2026-10-28.endive" });

for (const [plan, config] of Object.entries(paidPlans)) {
  const lookup = `texfolia_${plan}_monthly`;
  let price = (await stripe.prices.list({ lookup_keys: [lookup], limit: 1 }))
    .data[0];
  if (!price) {
    const product = await stripe.products.create(
      { name: `Texfolia ${config.name}`, metadata: { plan } },
      { idempotencyKey: `${lookup}_product` },
    );
    price = await stripe.prices.create(
      {
        product: product.id,
        lookup_key: lookup,
        currency: "usd",
        unit_amount: config.monthlyUsd * 100,
        recurring: { interval: "month", usage_type: "licensed" },
      },
      { idempotencyKey: `${lookup}_price` },
    );
  }
  if (
    !price.active ||
    price.currency !== "usd" ||
    price.unit_amount !== config.monthlyUsd * 100 ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed" ||
    price.billing_scheme !== "per_unit"
  ) {
    throw new Error(
      `The existing ${plan} price does not match the monthly plan`,
    );
  }
  console.info(`STRIPE_${plan.toUpperCase()}_PRICE_ID=${price.id}`);
}
