import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@texfolia/ui/button";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from "@texfolia/ui/item";
import { useState } from "react";

import { connectGitAccount } from "#/components/git-remote-form";
import { getConnections } from "#/lib/account-settings.functions";
import { authClient } from "#/lib/auth-client";
import { hasRepositoryAccess, isGitProvider } from "#/lib/git-providers";
export const Route = createFileRoute("/settings/connections")({
  loader: () => getConnections(),
  component: ConnectionsPage,
});
const providers = [
  { id: "github", label: "GitHub" },
  { id: "gitlab", label: "GitLab" },
  { id: "google", label: "Google" },
  { id: "microsoft", label: "Microsoft" },
] as const;
function ConnectionsPage() {
  const accounts = Route.useLoaderData();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Connections</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Manage linked sign-in accounts and grant repository access for Git.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {providers.map(({ id, label }) => {
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
            <Button
              variant="outline"
              disabled={
                pending !== null || (linked.length > 0 && (!git || repoAccess))
              }
              onClick={() => {
                setPending(id);
                setError("");
                void (async () => {
                  try {
                    if (git) await connectGitAccount(id);
                    else {
                      const result = await authClient.linkSocial({
                        provider: id,
                        callbackURL: window.location.href,
                      });
                      if (result.error)
                        throw new Error(
                          result.error.message ?? "Could not connect account.",
                        );
                    }
                  } catch (cause) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Could not connect account.",
                    );
                  } finally {
                    setPending(null);
                  }
                })();
              }}
            >
              {pending === id
                ? "Connecting…"
                : linked.length > 0
                  ? git && !repoAccess
                    ? "Grant repository access"
                    : "Connected"
                  : "Connect"}
            </Button>
          </Item>
        );
      })}
    </div>
  );
}
