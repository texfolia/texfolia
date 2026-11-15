import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { getOrganizationInvitation } from "#/lib/organization.functions";
import { ThemeProvider } from "#/providers/theme-provider";

export const Route = createFileRoute("/accept-invitation/$invitationId")({
  ssr: false,
  beforeLoad: ({ location, context }) => {
    if (!context.appUser) {
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
  head: () => ({ meta: [{ title: "Project invitation | Texfolia" }] }),
  component: InvitationPage,
  errorComponent: InvitationError,
});

function InvitationError() {
  const { invitationId } = Route.useParams();
  return (
    <InvitationTheme>
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6 py-12">
        <h1 className="font-heading text-2xl font-semibold">
          Invitation unavailable
        </h1>
        <p className="text-muted-foreground leading-relaxed wrap-anywhere">
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
    </InvitationTheme>
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
    <InvitationTheme>
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
        <Link to="/" className="mb-8 font-serif text-3xl tracking-tight">
          Texfolia.
        </Link>
        <div className="space-y-3">
          <h1 className="font-heading text-2xl font-semibold">
            Join {invitation.organizationName}
          </h1>
          <p className="text-muted-foreground leading-relaxed wrap-anywhere">
            {invitation.inviterEmail} invited {invitation.email} to join as a{" "}
            {invitation.role}.
          </p>
          <p className="text-muted-foreground leading-relaxed wrap-anywhere">
            Your personal projects and subscription stay with your account.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button onClick={acceptInvitation} disabled={isAccepting}>
          {isAccepting ? "Joining…" : "Accept invitation"}
        </Button>
        <Link
          to="/projects"
          className="text-center underline underline-offset-4"
        >
          Back to personal projects
        </Link>
      </main>
    </InvitationTheme>
  );
}

function InvitationTheme({ children }: { children: ReactNode }) {
  const { appUser } = Route.useRouteContext();
  return appUser ? (
    <ThemeProvider userId={appUser.id}>{children}</ThemeProvider>
  ) : (
    children
  );
}
