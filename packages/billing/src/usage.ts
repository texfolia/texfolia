/** AI usage is stored and metered in billionths of a US dollar. */
export const nanoDollars = 1_000_000_000;

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

/** A billing refusal whose message is safe to show, with its HTTP status. */
export class BillingError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
