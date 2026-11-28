import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { connectGitAccount } from "#/components/git-remote-form";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from "#/components/ui/item";
import { authClient } from "#/lib/auth/auth-client";
import { hasRepositoryAccess, isGitProvider } from "#/lib/git";
import { getConnections } from "#/lib/settings/account-settings.functions";

const path = "/settings/connections";

export const Route = createFileRoute("/settings/connections")({
  // The router keeps raw search values that a validator omits.
  validateSearch: (search: Record<string, unknown>): { error?: string } => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  loader: () => getConnections(),
  component: ConnectionsPage,
});
const providers = [
  { id: "github", label: "GitHub" },
  { id: "gitlab", label: "GitLab" },
  { id: "google", label: "Google" },
  { id: "microsoft", label: "Microsoft" },
] as const;
type Provider = (typeof providers)[number];

// Better Auth's OAuth callback error codes.
const callbackErrors: Record<string, string> = {
  access_denied: "The connection was canceled.",
  email_does_not_match:
    "That account uses a different email address. Connect one with the email of your Texfolia account.",
  account_already_linked_to_different_user:
    "That account is connected to another Texfolia account.",
};

function ConnectionsPage() {
  const accounts = Route.useLoaderData();
  const { error: callbackError } = Route.useSearch();
  const { user } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<Provider | null>(null);
  const [error, setError] = useState(
    callbackError
      ? (callbackErrors[callbackError] ??
          "The account could not be connected. Try again.")
      : "",
  );
  const [signInAgain, setSignInAgain] = useState(false);
  const [status, setStatus] = useState("");

  async function run(id: string, action: () => Promise<void>) {
    setPending(id);
    setError("");
    setSignInAgain(false);
    setStatus("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The connection failed.",
      );
    } finally {
      setPending(null);
    }
  }

  const connect = ({ id }: Provider) =>
    void run(id, async () => {
      const urls = { callbackURL: path, errorCallbackURL: path };
      if (isGitProvider(id)) {
        await connectGitAccount(id, urls);
        return;
      }
      const result = await authClient.linkSocial({ provider: id, ...urls });
      if (result.error)
        throw new Error(result.error.message ?? "Could not connect account.");
    });

  const disconnect = ({ id, label }: Provider) =>
    void run(id, async () => {
      for (const account of accounts) {
        if (account.provider !== id) continue;
        const { error } = await authClient.unlinkAccount({
          accountId: account.id,
        });
        // Already gone, as when another tab disconnected it.
        if (!error || error.code === "ACCOUNT_NOT_FOUND") continue;
        setSignInAgain(error.code === "SESSION_NOT_FRESH");
        throw new Error(
          error.code === "SESSION_NOT_FRESH"
            ? "Disconnecting needs a sign-in from the last 24 hours."
            : (error.message ?? "Could not disconnect account."),
        );
      }
      setDisconnecting(null);
      // Drops a stale `?error=` too.
      await navigate({ search: {}, replace: true });
      await router.invalidate();
      setStatus(`${label} disconnected.`);
    });

  const alert = error && (
    <p role="alert" className="text-destructive text-sm">
      {error}{" "}
      {signInAgain && (
        <Link
          to="/login"
          search={{ redirectTo: path }}
          className="underline underline-offset-4"
        >
          Sign in again
        </Link>
      )}
    </p>
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Connections</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Manage linked sign-in accounts and grant repository access for Git.
          Reconnect an account if its access was revoked elsewhere.
        </p>
      </div>
      {!disconnecting && alert}
      <p role="status" className="text-muted-foreground text-sm empty:sr-only">
        {status}
      </p>
      {providers.map((provider) => {
        const { id, label } = provider;
        const linked = accounts.filter((account) => account.provider === id);
        const git = isGitProvider(id);
        const repoAccess =
          git &&
          linked.some((account) => hasRepositoryAccess(id, account.scope));
        return (
          <Item key={id} variant="outline">
            <ItemContent>
              <ItemTitle>{label}</ItemTitle>
              <ItemDescription>
                {linked.length ? "Connected" : "Not connected"}
                {git && linked.length > 0
                  ? repoAccess
                    ? " · Repository access granted"
                    : " · Sign-in only"
                  : ""}
              </ItemDescription>
            </ItemContent>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={pending !== null}
                aria-label={`${linked.length ? (git && !repoAccess ? "Grant repository access to" : "Reconnect") : "Connect"} ${label}`}
                onClick={() => connect(provider)}
              >
                {pending === id && !disconnecting
                  ? "Connecting…"
                  : !linked.length
                    ? "Connect"
                    : git && !repoAccess
                      ? "Grant repository access"
                      : "Reconnect"}
              </Button>
              {linked.length > 0 && (
                <Button
                  variant="outline"
                  disabled={pending !== null}
                  aria-label={`Disconnect ${label}`}
                  onClick={() => {
                    setError("");
                    setSignInAgain(false);
                    setDisconnecting(provider);
                  }}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </Item>
        );
      })}
      <AlertDialog
        open={!!disconnecting}
        onOpenChange={(open) => {
          if (!open && !pending) setDisconnecting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            Disconnect {disconnecting?.label}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Texfolia deletes its access tokens.{" "}
            {disconnecting && isGitProvider(disconnecting.id)
              ? "Pushing, pulling and importing stop working until you connect again. "
              : ""}
            You can still sign in with a code sent to {user.email}. To remove
            Texfolia from the list of apps at {disconnecting?.label}, use its
            own settings.
          </AlertDialogDescription>
          {alert}
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() => setDisconnecting(null)}
            >
              Keep connected
            </Button>
            <Button
              variant="destructive"
              disabled={pending !== null}
              onClick={() => disconnecting && disconnect(disconnecting)}
            >
              {pending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
