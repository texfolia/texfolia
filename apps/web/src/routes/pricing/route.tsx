import { IconCheck } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { paidPlans } from "#/lib/billing";
import {
  maxSourceFileBytes,
  maxSourceProjectBytes,
} from "#/lib/project-source";

const storagePolicy = `${maxSourceFileBytes / 1024 ** 2} MiB per source file; ${maxSourceProjectBytes / 1024 ** 2} MiB per project`;

export const Route = createFileRoute("/pricing")({
  head: () => ({ meta: [{ title: "Pricing | Texfolia" }] }),
  component: RouteComponent,
});

const PLANS = [
  {
    name: "Free",
    description: "For learning LaTeX and writing together.",
    price: 0,
    plan: null,
    priceUnit: "",
    buttonVariant: "outline",
    buttonText: "Get started for free",
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
    plan: "pro",
    priceUnit: "/month",
    buttonVariant: "default",
    buttonText: "Upgrade to Pro",
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
    plan: "team",
    priceUnit: "/user/month",
    buttonVariant: "outline",
    buttonText: "Upgrade to Team",
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
] satisfies readonly {
  name: string;
  description: string;
  price: number;
  plan: "pro" | "team" | null;
  priceUnit: string;
  buttonVariant: "default" | "outline";
  buttonText: string;
  features: readonly string[];
}[];

const COMPARISON = [
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
];

function RouteComponent() {
  return (
    <div className="flex min-h-svh flex-col">
      <Header />
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
          {PLANS.map((plan) => (
            <Card key={plan.name} className="flex h-full flex-col py-8">
              <CardHeader className="gap-4 px-6">
                <CardTitle className="text-xl">{plan.name}</CardTitle>
                <CardDescription className="min-h-12 leading-6">
                  {plan.description}
                </CardDescription>
                <p className="text-5xl font-medium tracking-tight tabular-nums">
                  ${plan.price}
                  {"priceUnit" in plan && (
                    <span className="text-muted-foreground ml-1 text-sm font-normal tracking-normal">
                      {plan.priceUnit}
                    </span>
                  )}
                </p>
              </CardHeader>
              <CardContent>
                <Button
                  size="lg"
                  variant={plan.buttonVariant}
                  className="w-full"
                  render={
                    plan.plan ? (
                      <Link
                        to="/settings/billing"
                        search={{ plan: plan.plan }}
                      />
                    ) : (
                      <Link to="/projects" />
                    )
                  }
                >
                  {plan.buttonText}
                </Button>
              </CardContent>
              <CardFooter className="px-6 pt-4">
                <ul className="space-y-4 text-sm">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <IconCheck className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </CardFooter>
            </Card>
          ))}
        </div>
        <p className="text-muted-foreground mt-5 text-sm">
          Prices are in USD. AI usage is extra, reported to Stripe after each
          run and invoiced monthly. The launch markup is 20%; each user can
          adjust their monthly AI spend cap, including setting it to $0 to pause
          AI.
        </p>
        <Card className="mt-12">
          <CardContent>
            <h2 className="mb-4 text-xl font-semibold">Compare plans</h2>
            <p className="text-muted-foreground mb-4 text-sm md:hidden">
              Scroll horizontally to compare all plans.
            </p>
            <Table className="min-w-3xl" aria-label="Plan comparison">
              <TableCaption>
                Plan limits apply equally to personal and organization projects.
                Compilation is subject to fair use.
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
                {COMPARISON.map(([feature, ...values]) => (
                  <TableRow key={feature}>
                    <TableHead
                      scope="row"
                      className="font-medium whitespace-normal"
                    >
                      {feature}
                    </TableHead>
                    {values.map((value, index) => (
                      <TableCell key={index} className="whitespace-normal">
                        {value}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <p className="text-muted-foreground mt-8 text-sm">
          Compilation on every plan is subject to{" "}
          <Link to="/terms" className="underline underline-offset-4">
            fair use
          </Link>
          .
        </p>
      </main>
      <Footer />
    </div>
  );
}
