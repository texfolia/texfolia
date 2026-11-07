import GitLabIcon from "@iconify-react/thesvg-color/gitlab";
import GoogleIcon from "@iconify-react/thesvg-color/google";
import MicrosoftIcon from "@iconify-react/thesvg-color/microsoft";
import GithubIcon from "@iconify-react/thesvg/github";
import { createFileRoute } from "@tanstack/react-router";

import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";

export const Route = createFileRoute("/login")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4">
      <div className="flex w-full flex-col gap-2">
        <Button
          onClick={() =>
            authClient.signIn.social({
              provider: "github",
            })
          }
          size="lg"
          className="rounded-full"
        >
          <GithubIcon />
          Continue with GitHub
        </Button>

        <Button
          onClick={() =>
            authClient.signIn.social({
              provider: "gitlab",
            })
          }
          size="lg"
          variant="outline"
          className="rounded-full"
        >
          <GitLabIcon />
          Continue with GitLab
        </Button>
        <Button
          onClick={() =>
            authClient.signIn.social({
              provider: "google",
            })
          }
          size="lg"
          variant="outline"
          className="rounded-full"
        >
          <GoogleIcon />
          Continue with Google
        </Button>
        <Button
          onClick={() =>
            authClient.signIn.social({
              provider: "microsoft",
            })
          }
          size="lg"
          variant="outline"
          className="rounded-full"
        >
          <MicrosoftIcon />
          Continue with Microsoft
        </Button>
        
      </div>
    </div>
  );
}
