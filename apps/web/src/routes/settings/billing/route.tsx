import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Button } from "@texfolia/ui/button";
import { Input } from "@texfolia/ui/input";
import { useRef, useState } from "react";

import { authClient } from "#/lib/auth/auth-client";
import { paidPlans } from "#/lib/billing";
import { billingSearch } from "#/lib/billing/billing-search";
import {
  getBilling,
  saveOrganizationCap,
} from "#/lib/billing/billing.functions";

export const Route = createFileRoute("/settings/billing")({
  ssr: false,
  validateSearch: billingSearch,
  loaderDeps: ({ search }) => ({ organizationId: search.organizationId }),
  loader: ({ deps }) => getBilling({ data: deps }),
  head: () => ({ meta: [{ title: "Billing | Texfolia" }] }),
  component: BillingRoutePage,
  errorComponent: BillingError,
});

const usd = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    amount,
  );

function BillingRoutePage() {
  const { organizationId, plan } = Route.useSearch();
  return <BillingPage key={organizationId ?? plan ?? "pro"} />;
}

function BillingError() {
  const router = useRouter();
  return (
    <div className="flex flex-col">
      <main
        id="main-content"
        className="mx-auto w-full max-w-3xl space-y-5 px-6 py-16"
      >
        <h1 className="font-serif text-4xl">Billing unavailable</h1>
        <p className="text-muted-foreground leading-7">
          We couldn't load this billing account. Check your connection and make
          sure you're a member of the organization.
        </p>
        <Button onClick={() => void router.invalidate()}>Try again</Button>
        <Link
          to="/settings/billing"
          className="ml-5 underline underline-offset-4"
        >
          Open personal billing
        </Link>
      </main>
    </div>
  );
}

function BillingPage() {
  const { organizations, selected, canManage, ai, subscriptions } =
    Route.useLoaderData();
  const { plan } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [name, setName] = useState("");
  const [cap, setCap] = useState(String(ai?.monthlyCapDollars ?? ""));
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const team = !!selected || plan === "team";
  const subscription = subscriptions[0];
  const scope = selected
    ? { customerType: "organization" as const, referenceId: selected.id }
    : { customerType: "user" as const };

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    setStatus("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "We couldn't update billing. Please try again.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function checkout() {
    if (team && !selected) return;
    const result = await authClient.subscription.upgrade({
      ...scope,
      plan: selected ? "team" : "pro",
      successUrl: selected
        ? `/settings/billing?organizationId=${encodeURIComponent(selected.id)}`
        : "/settings/billing",
      cancelUrl: selected
        ? `/settings/billing?organizationId=${encodeURIComponent(selected.id)}`
        : "/settings/billing?plan=pro",
      returnUrl: selected
        ? `/settings/billing?organizationId=${encodeURIComponent(selected.id)}`
        : "/settings/billing",
    });
    if (result.error)
      throw new Error(
        result.error.message || "Checkout is unavailable. Please try again.",
      );
  }

  return (
    <div className="flex flex-col">
      <main id="main-content" className="w-full space-y-8">
        <div>
          <h1 className="text-xl font-semibold">Billing</h1>
          <p className="text-muted-foreground mt-4 leading-7">
            Manage your personal plan or share a Team subscription with your
            organization.
          </p>
        </div>
        <nav aria-label="Billing account" className="flex flex-wrap gap-3">
          <Button
            variant={!team ? "default" : "outline"}
            render={<Link to="/settings/billing" search={{ plan: "pro" }} />}
          >
            Personal
          </Button>
          {organizations.map((org) => (
            <Button
              key={org.id}
              variant={selected?.id === org.id ? "default" : "outline"}
              render={
                <Link
                  to="/settings/billing"
                  search={{ organizationId: org.id }}
                />
              }
            >
              {org.name}
            </Button>
          ))}
          <Button
            variant={team && !selected ? "default" : "outline"}
            render={<Link to="/settings/billing" search={{ plan: "team" }} />}
          >
            New team
          </Button>
        </nav>
        <p role="alert" className="text-destructive text-sm empty:sr-only">
          {error}
        </p>
        <p
          role="status"
          className="text-muted-foreground text-sm empty:sr-only"
        >
          {status}
        </p>
        {team && !selected ? (
          <form
            className="space-y-4 border-t pt-8"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await authClient.organization.create({
                  name: name.trim(),
                  slug: `team-${crypto.randomUUID()}`,
                  keepCurrentActiveOrganization: true,
                });
                if (result.error || !result.data)
                  throw new Error(
                    result.error?.message ||
                      "We couldn't create your team. Please try again.",
                  );
                await navigate({ search: { organizationId: result.data.id } });
              });
            }}
          >
            <h2 className="text-xl font-semibold">Start a Team plan</h2>
            <p className="text-muted-foreground leading-7">
              Pro compiles for every organization member and AI in the
              organization's projects, at ${paidPlans.team.monthlyUsd} USD per
              user per month (excluding applicable tax) on one shared bill.
              Create your organization, then continue to Stripe checkout.
              Personal and Team subscriptions are billed separately.
            </p>
            <label htmlFor="team-name" className="block text-sm font-medium">
              Organization name
            </label>
            <Input
              id="team-name"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating organization…" : "Create organization"}
            </Button>
          </form>
        ) : (
          <section
            className="space-y-4 border-t pt-8"
            aria-labelledby="plan-heading"
          >
            <h2 id="plan-heading" className="text-xl font-semibold">
              {selected ? `${selected.name} · Team` : "Personal · Pro"}
            </h2>
            <p className="text-muted-foreground leading-7">
              {selected
                ? `${selected.seats} ${selected.seats === 1 ? "member" : "members"} × $${paidPlans.team.monthlyUsd} USD/month = $${selected.seats * paidPlans.team.monthlyUsd} USD/month, excluding applicable tax. Every member, including owners and admins, is a paid seat. Seat changes are prorated.`
                : `$${paidPlans.pro.monthlyUsd} USD/month, excluding applicable tax, for your personal account.`}
            </p>
            <p className="text-muted-foreground leading-7">
              AI usage is extra: model cost plus 20%, reported to Stripe after
              each run and invoiced monthly. Each user controls their own
              monthly spend cap (default $20, pre-tax; applicable tax is added
              on the invoice).{" "}
              {selected &&
                "The organization pays for members' usage in its own projects, up to a shared monthly cap (pre-tax) set by its owners and admins. Usage in personal projects needs a personal Pro plan, which is billed separately."}
            </p>
            {!canManage ? (
              <p>Only an organization owner or admin can manage billing.</p>
            ) : subscription ? (
              <>
                <p className="text-sm">
                  {subscription.plan === "team" ? "Team" : "Pro"} subscription:{" "}
                  {subscription.status}
                  {subscription.cancelAtPeriodEnd
                    ? "; cancels at the end of the billing period"
                    : ""}
                  .
                </p>
                <Button
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      const result =
                        await authClient.subscription.billingPortal({
                          ...scope,
                          returnUrl: window.location.href,
                        });
                      if (result.error)
                        throw new Error(
                          result.error.message ||
                            "We couldn't open billing. Please try again.",
                        );
                    })
                  }
                >
                  {pending
                    ? "Opening billing…"
                    : "Manage subscription and invoices"}
                </Button>
              </>
            ) : (
              <Button disabled={pending} onClick={() => void run(checkout)}>
                {pending
                  ? "Opening checkout…"
                  : `Continue to ${selected ? "Team" : "Pro"} checkout`}
              </Button>
            )}
            <p className="text-muted-foreground text-sm">
              Subscription changes are confirmed after Stripe processes payment.{" "}
              <Link to="/pricing" className="underline underline-offset-4">
                Compare plans
              </Link>
              {" · "}
              <Link
                to="/settings/usage"
                search={
                  selected && canManage ? { organizationId: selected.id } : {}
                }
                className="underline underline-offset-4"
              >
                View usage &amp; cost charts
              </Link>
            </p>
          </section>
        )}
        {selected && ai && (
          <section
            className="space-y-4 border-t pt-8"
            aria-labelledby="ai-heading"
          >
            <h2 id="ai-heading" className="text-xl font-semibold">
              AI usage
            </h2>
            <p className="text-muted-foreground text-sm leading-6">
              Members have used {usd(ai.spentDollars)} this month (UTC), with{" "}
              {usd(ai.reservedDollars)} reserved for running requests. The
              shared cap applies on top of each member's own cap.
            </p>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await saveOrganizationCap({
                    data: { organizationId: selected.id, dollars: Number(cap) },
                  });
                  await router.invalidate();
                  setStatus("Organization AI spend cap saved.");
                });
              }}
            >
              <label htmlFor="organization-cap" className="text-sm font-medium">
                Organization monthly AI spend cap (USD)
              </label>
              <Input
                id="organization-cap"
                type="number"
                min={0}
                max={10000}
                step="0.01"
                required
                value={cap}
                disabled={pending}
                onChange={(event) => setCap(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                A $0 cap prevents new AI requests billed to the organization.
                Caps apply to pre-tax usage; applicable tax is added on the
                invoice.
              </p>
              <Button
                type="submit"
                variant="outline"
                disabled={pending || Number(cap) === ai.monthlyCapDollars}
              >
                Save cap
              </Button>
            </form>
          </section>
        )}
        {selected && (
          <section className="border-t pt-8">
            <Link
              to="/settings/organizations"
              search={{ organizationId: selected.id }}
              className="underline underline-offset-4"
            >
              {canManage ? "Manage members and roles" : "See members"}
            </Link>
          </section>
        )}
        <Link
          to="/projects"
          className="inline-block underline underline-offset-4"
        >
          Back to projects
        </Link>
      </main>
    </div>
  );
}
