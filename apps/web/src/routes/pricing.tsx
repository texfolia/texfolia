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
import { historyPolicy } from "#/lib/document-history";

export const Route = createFileRoute("/pricing")({
  head: () => ({ meta: [{ title: "Pricing | Texfolia" }] }),
  component: RouteComponent,
});

const PLANS = [
  {
    name: "Free",
    description:
      "Perfect for learning LaTeX and familiarizing yourself with the platform",
    price: 0,
    buttonVariant: "outline",
    buttonText: "Get started for free",
    features: [
      historyPolicy,
      "100 projects",
      "4 editors per project",
      "1 GB storage",
      "15-second compile timeout",
    ],
  },
  {
    name: "Pro",
    description: "",
    price: 15,
    priceUnit: "/month",
    buttonVariant: "default",
    buttonText: "Upgrade to Pro",
    features: [
      historyPolicy,
      "Unlimited projects",
      "10 editors per project",
      "10 GB storage",
      "5-minute compile timeout",
    ],
  },
  {
    name: "Team",
    description: "",
    price: 20,
    priceUnit: "/seat/month",
    buttonVariant: "outline",
    buttonText: "Contact Sales",
    features: [
      historyPolicy,
      "Unlimited projects",
      "Unlimited editors per project",
      "100 GB storage / user",
      "5-minute compile timeout",
    ],
  },
] satisfies readonly {
  name: string;
  description: string;
  price: number;
  priceUnit?: string;
  buttonVariant: "default" | "outline";
  buttonText: string;
  features: readonly string[];
}[];

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
                {plan.name === "Free" ? (
                  <Button
                    size="lg"
                    variant={plan.buttonVariant}
                    className="w-full"
                    render={<Link to="/login" />}
                  >
                    {plan.buttonText}
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    variant={plan.buttonVariant}
                    className="w-full"
                    disabled
                    title="Paid plan checkout is not available yet"
                  >
                    {plan.buttonText}
                  </Button>
                )}
              </CardContent>
              <CardFooter className="mt-auto px-6 pt-4">
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
          Paid plan checkout is not available yet.
        </p>
        <Card className="mt-12">
          <CardContent>
            <Table>
              <TableCaption>
                * Unlimited is subject to fair use policy.
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
                <TableRow>
                  <TableCell></TableCell>
                  <TableCell></TableCell>
                  <TableCell></TableCell>
                  <TableCell></TableCell>
                </TableRow>
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
