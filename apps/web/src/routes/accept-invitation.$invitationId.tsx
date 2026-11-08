import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { getSession } from "#/lib/auth.functions";
import { getOrganizationInvitation } from "#/lib/organization.functions";

export const Route = createFileRoute("/accept-invitation/$invitationId")({
  beforeLoad: async ({ location }) => {
    if (!(await getSession())) {
      throw redirect({
        to: "/login",
        search: { redirectTo: location.pathname },
      });
    }
  },
  loader: ({ params }) =>
    getOrganizationInvitation({
      data: { invitationId: params.invitationId },
    }),
  component: InvitationPage,
  errorComponent: InvitationError,
});

function InvitationError() {
  const { invitationId } = Route.useParams();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="font-heading text-2xl font-semibold">
        Invitation unavailable
      </h1>
      <p className="text-muted-foreground">
        Sign in with the email address that received the invitation. If it has
        expired or was canceled, ask the sender for a new invitation.
      </p>
      <Link
        to="/login"
        search={{
          redirectTo: `/accept-invitation/${encodeURIComponent(invitationId)}`,
        }}
        className="underline underline-offset-4"
      >
        Sign in with another account
      </Link>
    </main>
  );
}

function InvitationPage() {
  const invitation = Route.useLoaderData();
  const navigate = useNavigate();
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function acceptInvitation() {
    setIsAccepting(true);
    setError(null);
    try {
      const result = await authClient.organization.acceptInvitation({
        invitationId: invitation.id,
      });
      if (result.error) {
        setError(result.error.message ?? "Unable to accept this invitation.");
        return;
      }
      await navigate({ to: "/projects" });
    } catch {
      setError("Unable to accept this invitation. Please try again.");
    } finally {
      setIsAccepting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <div className="space-y-3">
        <h1 className="font-heading text-2xl font-semibold">
          Join {invitation.organizationName}
        </h1>
        <p className="text-muted-foreground">
          {invitation.inviterEmail} invited {invitation.email} to join as a{" "}
          {invitation.role}.
        </p>
        <p className="text-muted-foreground">
          Your personal projects and subscription stay with your account.
        </p>
      </div>
      {error && <p role="alert">{error}</p>}
      <Button onClick={acceptInvitation} disabled={isAccepting}>
        {isAccepting ? "Joining…" : "Accept invitation"}
      </Button>
      <Link to="/projects" className="text-center underline underline-offset-4">
        Back to personal projects
      </Link>
    </main>
  );
}
