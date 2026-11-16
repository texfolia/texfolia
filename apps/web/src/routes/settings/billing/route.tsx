import {
  createFileRoute,
  Link,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { useRef, useState } from "react";
import { z } from "zod";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { authClient } from "#/lib/auth-client";
import { getSession } from "#/lib/auth.functions";
import { paidPlans } from "#/lib/billing";
import { getBilling } from "#/lib/billing.functions";

export const Route = createFileRoute("/settings/billing")({
  ssr: false,
  validateSearch: z.object({
    plan: z.enum(["pro", "team"]).optional(),
    organizationId: z.string().min(1).optional(),
  }),
  beforeLoad: async ({ location }) => {
    if (!(await getSession())) {
      throw redirect({ to: "/login", search: { redirectTo: location.href } });
    }
  },
  loaderDeps: ({ search }) => ({ organizationId: search.organizationId }),
  loader: ({ deps }) => getBilling({ data: deps }),
  head: () => ({ meta: [{ title: "Billing | Texfolia" }] }),
  component: BillingRoutePage,
  errorComponent: BillingError,
});

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
  const { organizations, selected, canManage, subscriptions, userId } =
    Route.useLoaderData();
  const { plan } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
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
              Pro for every organization member, at ${paidPlans.team.monthlyUsd}{" "}
              USD per user per month on one shared bill. Create your
              organization, then continue to Stripe checkout. Personal and Team
              subscriptions are billed separately.
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
                ? `${selected.members.length} ${selected.members.length === 1 ? "member" : "members"} × $${paidPlans.team.monthlyUsd} USD/month = $${selected.members.length * paidPlans.team.monthlyUsd} USD/month. Every member, including owners and admins, is a paid seat. Seat changes are prorated.`
                : `$${paidPlans.pro.monthlyUsd} USD/month for your personal account.`}
            </p>
            <p className="text-muted-foreground leading-7">
              AI usage is extra: model cost plus 20%, reported to Stripe after
              each run and invoiced monthly. Each user controls their own
              monthly spend cap (default $20).{" "}
              {selected &&
                "Eligible Team usage is charged to the shared subscription. Personal and Team subscriptions are billed separately."}
            </p>
            {!canManage ? (
              <p>
                Only an organization owner or admin can manage billing and
                members.
              </p>
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
            </p>
          </section>
        )}
        {selected && canManage && (
          <section
            className="space-y-5 border-t pt-8"
            aria-labelledby="members-heading"
          >
            <h2 id="members-heading" className="text-xl font-semibold">
              Team members
            </h2>
            <p className="text-muted-foreground text-sm leading-6">
              Invitations become paid seats when accepted. Removing a member
              removes their Team access and updates your seat count.
            </p>
            <ul className="divide-y">
              {selected.members.map((member) => (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="wrap-anywhere">{member.user.email}</p>
                    <p className="text-muted-foreground text-sm">
                      {member.role}
                    </p>
                  </div>
                  {member.userId !== userId && member.role === "member" && (
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void run(async () => {
                          const result =
                            await authClient.organization.removeMember({
                              organizationId: selected.id,
                              memberIdOrEmail: member.id,
                            });
                          if (result.error)
                            throw new Error(
                              result.error.message ||
                                "We couldn't remove this member. Please try again.",
                            );
                          await router.invalidate();
                          setStatus(
                            "Member removed. Billing follows current membership.",
                          );
                        })
                      }
                    >
                      Remove member
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await authClient.organization.inviteMember({
                    organizationId: selected.id,
                    email: email.trim(),
                    role: "member",
                  });
                  if (result.error)
                    throw new Error(
                      result.error.message ||
                        "We couldn't send this invitation. Please try again.",
                    );
                  setEmail("");
                  await router.invalidate();
                  setStatus(
                    "Invitation sent. A seat will be added when it is accepted.",
                  );
                });
              }}
            >
              <label htmlFor="member-email" className="text-sm font-medium">
                Invite by email
              </label>
              <Input
                id="member-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button type="submit" variant="outline" disabled={pending}>
                Send invitation
              </Button>
            </form>
            <ul className="space-y-3">
              {selected.invitations
                .filter((invite) => invite.status === "pending")
                .map((invite) => (
                  <li
                    key={invite.id}
                    className="flex flex-wrap items-center justify-between gap-3 text-sm"
                  >
                    <span className="wrap-anywhere">
                      {invite.email} · Invited
                    </span>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        void run(async () => {
                          const result =
                            await authClient.organization.cancelInvitation({
                              invitationId: invite.id,
                            });
                          if (result.error)
                            throw new Error(
                              result.error.message ||
                                "We couldn't cancel this invitation. Please try again.",
                            );
                          await router.invalidate();
                        })
                      }
                    >
                      Cancel invitation
                    </Button>
                  </li>
                ))}
            </ul>
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
