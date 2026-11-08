import { IconCheck } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";

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

export const Route = createFileRoute("/pricing")({
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
      "100 projects",
      "4 editors per project",
      "1 GB storage",
      "1,000 compile-seconds / month",
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
      "Unlimited projects",
      "10 editors per project",
      "10 GB storage",
      "10,000 compile-seconds / month",
      "5-minute compile timeout",
    ],
  },
  {
    name: "Team",
    description: "",
    price: 20,
    priceUnit: "/user/month",
    buttonVariant: "outline",
    buttonText: "Contact Sales",
    features: [
      "Unlimited projects",
      "Unlimited editors per project",
      "100 GB storage / user",
      "Unlimited compile-seconds / month",
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
    <div>
      <Header />
      <main>
        <h1>Pricing</h1>
        <p>Choose the plan that's right for you and your team.</p>
        <div className="grid grid-cols-3">
          {PLANS.map((plan) => (
            <Card key={plan.name}>
              <CardHeader>
                <CardTitle>{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button size="lg" variant={plan.buttonVariant}>
                  {plan.buttonText}
                </Button>
              </CardContent>
              <CardFooter>
                <ul>
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <IconCheck />
                      {feature}
                    </li>
                  ))}
                </ul>
              </CardFooter>
            </Card>
          ))}
        </div>
        <Card>
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
      </main>
      <Footer />
    </div>
  );
}
