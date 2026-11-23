/** Maps Stripe price IDs to Better Auth Stripe plans. */
export function subscriptionPlans({
  proPriceId,
  teamPriceId,
}: {
  proPriceId: string;
  teamPriceId: string;
}) {
  return [
    { name: "pro", priceId: proPriceId },
    { name: "team", priceId: teamPriceId, seatPriceId: teamPriceId },
  ];
}
