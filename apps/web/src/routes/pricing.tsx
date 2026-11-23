import { createFileRoute, Link } from "@tanstack/react-router";
import { paidPlans } from "@texfolia/auth/billing";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@texfolia/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@texfolia/ui/table";

import { Page } from "#/components/page";
import { pageHead } from "#/lib/head";
import { linkButton } from "#/lib/link-button";
import { appPath } from "#/lib/urls";

export const Route = createFileRoute("/pricing")({
  head: () => pageHead({ title: "Pricing | Texfolia" }),
  component: Pricing,
});

const storagePolicy = "10 MiB per source file; 50 MiB per project";

const plans = [
  {
    name: "Free",
    description: "For learning LaTeX and writing together.",
    price: 0,
    priceUnit: "",
    primary: false,
    buttonText: "Get started for free",
    href: appPath("/projects"),
    features: [
      "No project or editor count limit",
      storagePolicy,
      "GitHub and GitLab integration",
      "15-second compile timeout",
      "No AI assistant",
    ],
  },
  {
    name: paidPlans.pro.name,
    description: "For longer compiles and an AI writing assistant.",
    price: paidPlans.pro.monthlyUsd,
    priceUnit: "/month",
    primary: true,
    buttonText: "Upgrade to Pro",
    href: appPath("/settings/billing?plan=pro"),
    features: [
      "No project or editor count limit",
      storagePolicy,
      "GitHub and GitLab integration",
      "5-minute compile timeout",
      "AI assistant, billed separately at model cost + 20%",
      "Monthly metered AI billing with a per-user spend cap",
    ],
  },
  {
    name: paidPlans.team.name,
    description: "Pro for every user, with one shared organization bill.",
    price: paidPlans.team.monthlyUsd,
    priceUnit: "/user/month",
    primary: false,
    buttonText: "Upgrade to Team",
    href: appPath("/settings/billing?plan=team"),
    features: [
      "Pro benefits for every organization member",
      "No project or editor count limit",
      storagePolicy,
      "GitHub and GitLab integration",
      "5-minute compile timeout",
      "AI assistant, billed separately at model cost + 20%",
      "Monthly metered AI billing with a per-user spend cap",
      "Shared billing; seats follow membership",
    ],
  },
];

const comparison = [
  ["Projects", "No count limit", "No count limit", "No count limit"],
  ["Editors per project", "No count limit", "No count limit", "No count limit"],
  ["Source storage", storagePolicy, storagePolicy, storagePolicy],
  [
    "Git version history",
    "GitHub and GitLab integration",
    "GitHub and GitLab integration",
    "GitHub and GitLab integration",
  ],
  ["Compile timeout", "15 seconds", "5 minutes", "5 minutes"],
  [
    "AI assistant",
    "Not included",
    "Model cost + 20%",
    "Model cost + 20% per user",
  ],
  [
    "AI billing",
    "Not available",
    "Metered; invoiced monthly",
    "Metered; shared monthly invoice",
  ],
  [
    "AI spend cap",
    "Not available",
    "Per user; default $20/month",
    "Per user; default $20/month",
  ],
  [
    "Subscription billing",
    "Free",
    "Personal",
    "$20/user/month; shared organization bill",
  ],
] as const;

function Pricing() {
  return (
    <Page>
      <main
        id="main-content"
        className="mx-auto w-full max-w-7xl px-6 py-16 sm:px-8 sm:py-24"
      >
        <h1 className="font-serif text-6xl tracking-tight sm:text-7xl">
          Space to do your best work.
        </h1>
        <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
          Choose the plan that's right for you and your team.
        </p>
        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {plans.map((plan) => (
            <article key={plan.name}>
              <Card className="h-full [--card-spacing:--spacing(6)]">
                <CardHeader className="gap-4">
                  <CardTitle className="text-xl font-semibold">
                    <h2>{plan.name}</h2>
                  </CardTitle>
                  <CardDescription className="min-h-12 text-base leading-6">
                    <p>{plan.description}</p>
                  </CardDescription>
                  <p className="text-5xl font-medium tracking-tight tabular-nums">
                    ${plan.price}
                    {plan.priceUnit && (
                      <span className="text-muted-foreground ml-1 text-sm font-normal tracking-normal">
                        {plan.priceUnit}
                      </span>
                    )}
                  </p>
                </CardHeader>
                <CardContent>
                  <a
                    href={plan.href}
                    className={linkButton({
                      variant: plan.primary ? "default" : "outline",
                      size: "lg",
                      className: "w-full",
                    })}
                  >
                    {plan.buttonText}
                  </a>
                </CardContent>
                <CardContent className="mt-auto">
                  <ul className="space-y-4">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-3">
                        <span
                          className="text-muted-foreground mt-0.5"
                          aria-hidden="true"
                        >
                          ✓
                        </span>
                        {feature}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </article>
          ))}
        </div>
        <p className="text-muted-foreground mt-5 text-sm">
          Prices are in USD. AI usage is extra, reported to Stripe after each
          run and invoiced monthly. The launch markup is 20%; each user can
          adjust their monthly AI spend cap, including setting it to $0 to pause
          AI.
        </p>
        <section className="mt-12">
          <Card className="[--card-spacing:--spacing(6)]">
            <CardContent>
              <h2 className="mb-4 text-xl font-semibold">Compare plans</h2>
              <p className="text-muted-foreground mb-4 text-sm md:hidden">
                Scroll horizontally to compare all plans.
              </p>
              <Table className="min-w-3xl" aria-label="Plan comparison">
                <TableCaption className="text-left">
                  Plan limits apply equally to personal and organization
                  projects. Compilation is subject to fair use.
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Feature</TableHead>
                    <TableHead>Free</TableHead>
                    <TableHead>Pro</TableHead>
                    <TableHead>Team</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparison.map(([feature, ...values]) => (
                    <TableRow key={feature}>
                      <TableHead scope="row" className="py-3 whitespace-normal">
                        {feature}
                      </TableHead>
                      {values.map((value, index) => (
                        <TableCell
                          key={index}
                          className="py-3 whitespace-normal"
                        >
                          {value}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>
        <p className="text-muted-foreground mt-8 text-sm">
          Compilation on every plan is subject to{" "}
          <Link to="/terms" className="underline underline-offset-4">
            fair use
          </Link>
          .
        </p>
      </main>
    </Page>
  );
}
