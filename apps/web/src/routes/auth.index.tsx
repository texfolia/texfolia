import { createFileRoute } from "@tanstack/react-router";

import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";

export const Route = createFileRoute("/auth/")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div>
      <Button
        onClick={() =>
          authClient.signIn.social({
            provider: "github",
          })
        }
      >
        Continue with GitHub
      </Button>
      <Button
        onClick={() =>
          authClient.signIn.social({
            provider: "gitlab",
          })
        }
      >
        Continue with GitLab
      </Button>
      <Button
        onClick={() =>
          authClient.signIn.social({
            provider: "google",
          })
        }
      >
        Continue with Google
      </Button>
      <Button>Continue with Email</Button>
    </div>
  );
}
