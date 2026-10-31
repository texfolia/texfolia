import {
  IconBrandGithubFilled,
  IconBrandGitlab,
  IconBrandGoogleFilled,
} from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";

export const Route = createFileRoute("/login")({
  component: RouteComponent,
});

function RouteComponent() {
  let [step, setStep] = useState<"email" | "token" | "otp">("email");

  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4">
      <h1>Log in to Texfolia</h1>
      <div className="flex flex-col gap-2">
        <Button
          onClick={() =>
            authClient.signIn.social({
              provider: "github",
            })
          }
          variant="outline"
          className="rounded-full px-5 py-5"
        >
          <IconBrandGithubFilled />
          Continue with GitHub
        </Button>
        <Button
          onClick={() =>
            authClient.signIn.social({
              provider: "gitlab",
            })
          }
          variant="outline"
          className="rounded-full px-5 py-5"
        >
          <IconBrandGitlab fill="curentColor" />
          Continue with GitLab
        </Button>
        <Button
          onClick={() =>
            authClient.signIn.social({
              provider: "google",
            })
          }
          variant="outline"
          className="rounded-full px-5 py-5"
        >
          <IconBrandGoogleFilled />
          Continue with Google
        </Button>
        <Button variant="outline" className="rounded-full px-5 py-5">
          Continue with Email
        </Button>
      </div>
    </div>
  );
}
