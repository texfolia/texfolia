export const paidPlans = {
  pro: { name: "Pro", monthlyUsd: 15 },
  team: { name: "Team", monthlyUsd: 20 },
} as const;

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
