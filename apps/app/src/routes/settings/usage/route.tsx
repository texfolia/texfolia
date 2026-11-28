import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@texfolia/ui/button";
import { Input } from "@texfolia/ui/input";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from "@texfolia/ui/item";
import { useState } from "react";

import { formatBytes } from "#/lib/format-bytes";
import {
  getAccountUsage,
  saveAccountAiSettings,
} from "#/lib/settings/account-settings.functions";
export const Route = createFileRoute("/settings/usage")({
  loader: () => getAccountUsage(),
  component: UsagePage,
});
const usd = (amount: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount);
function UsagePage() {
  const usage = Route.useLoaderData();
  const [cap, setCap] = useState(String(usage.monthlyCapDollars));
  const [saved, setSaved] = useState(cap);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Usage</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Current calendar month in UTC. Refresh this page for the latest
          totals.
        </p>
      </div>
      <Item variant="outline">
        <ItemContent className="gap-4">
          <ItemTitle>AI usage</ItemTitle>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <dt>Metered spend</dt>
            <dd className="text-right tabular-nums">
              {usd(usage.spentDollars)}
            </dd>
            <dt>Reserved for requests</dt>
            <dd className="text-right tabular-nums">
              {usd(usage.reservedDollars)}
            </dd>
            <dt>Pending requests</dt>
            <dd className="text-right tabular-nums">{usage.pendingRequests}</dd>
          </dl>
          {usage.needsReview && (
            <p role="status" className="text-sm">
              Some requests are awaiting billing reconciliation.
            </p>
          )}
          <form
            className="space-y-3 border-t pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              setPending(true);
              setError("");
              void saveAccountAiSettings({
                data: { kind: "cap", dollars: Number(cap) },
              })
                .then(() => {
                  setSaved(cap);
                  setMessage("Monthly cap saved.");
                })
                .catch((cause: unknown) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not save cap. Try again.",
                  ),
                )
                .finally(() => setPending(false));
            }}
          >
            <label htmlFor="ai-cap" className="text-sm font-medium">
              Monthly AI spend cap (USD)
            </label>
            <Input
              id="ai-cap"
              type="number"
              min={0}
              max={10000}
              step="0.01"
              required
              value={cap}
              onChange={(event) => setCap(event.target.value)}
              disabled={pending}
            />
            <p className="text-muted-foreground text-xs">
              A $0 cap prevents new AI requests. Model cost includes the
              existing 20% markup. Caps apply to pre-tax usage; applicable tax
              is added on the invoice.
            </p>
            <Button type="submit" disabled={pending || cap === saved}>
              {pending ? "Saving…" : "Save cap"}
            </Button>
          </form>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <p role="status" className="text-muted-foreground text-sm">
            {message}
          </p>
        </ItemContent>
      </Item>
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>Storage</ItemTitle>
          <ItemDescription>
            Current saved source data in {usage.projectCount}{" "}
            {usage.projectCount === 1 ? "project" : "projects"} you can access,
            including shared projects. Excludes deleted sources and compile
            artifacts.
          </ItemDescription>
          <p
            className="mt-3 text-sm tabular-nums"
            title={`${BigInt(usage.sourceBytes).toLocaleString()} bytes`}
          >
            {formatBytes(usage.sourceBytes)}
          </p>
        </ItemContent>
      </Item>
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>Compilations</ItemTitle>
          <ItemDescription>
            Compile jobs this month in projects you can access.
          </ItemDescription>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <dt>Total jobs</dt>
            <dd className="text-right tabular-nums">{usage.compiles.total}</dd>
            <dt>Succeeded</dt>
            <dd className="text-right tabular-nums">
              {usage.compiles.succeeded}
            </dd>
            <dt>Failed</dt>
            <dd className="text-right tabular-nums">{usage.compiles.failed}</dd>
          </dl>
        </ItemContent>
      </Item>
    </div>
  );
}
