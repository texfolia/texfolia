import { useEffect, useState } from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { gitRemoteSchema, gitScopes, type GitProvider } from "#/lib/git";
import { getGitAccounts } from "#/lib/git.functions";

export async function connectGitAccount(provider: GitProvider) {
  const result = await authClient.linkSocial({
    provider,
    scopes: gitScopes[provider],
    callbackURL: window.location.href,
  });
  if (result.error)
    throw new Error(result.error.message ?? "Could not connect account.");
}

export function GitRemoteForm({
  mode,
  onConnect,
  disabled = false,
}: {
  mode: "import" | "link";
  onConnect: (url: string, name: string) => Promise<void>;
  disabled?: boolean;
}) {
  const key = `texfolia.git.${mode}`;
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [accounts, setAccounts] = useState({ github: false, gitlab: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const saved = sessionStorage.getItem(key);
    if (saved) {
      const parts = saved.split("\n");
      setUrl(parts[0] ?? "");
      setName(parts[1] ?? "");
    }
    void getGitAccounts()
      .then(setAccounts)
      .catch(() =>
        setError("Could not check git accounts. Try reopening this panel."),
      );
  }, [key]);
  const parsed = gitRemoteSchema.safeParse(url);
  const provider = parsed.success ? parsed.data.provider : null;
  async function authorize(provider: GitProvider) {
    setError("");
    setBusy(true);
    try {
      sessionStorage.setItem(key, `${url}\n${name}`);
      await connectGitAccount(provider);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not connect account.",
      );
      setBusy(false);
    }
  }
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        if (!parsed.success) {
          setError(
            "Enter an HTTPS repository URL on github.com or gitlab.com.",
          );
          return;
        }
        if (!accounts[parsed.data.provider]) {
          await authorize(parsed.data.provider);
          return;
        }
        setBusy(true);
        try {
          await onConnect(url, name);
          sessionStorage.removeItem(key);
        } catch (error) {
          setError(
            error instanceof Error
              ? error.message
              : "Could not connect repository.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      {mode === "import" && (
        <div className="space-y-1">
          <Label htmlFor={`git-name-${mode}`}>Project name</Label>
          <Input
            id={`git-name-${mode}`}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled || busy}
          />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor={`git-url-${mode}`}>Repository URL</Label>
        <Input
          id={`git-url-${mode}`}
          type="url"
          required
          placeholder="https://github.com/owner/repository"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={disabled || busy}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        {mode === "link"
          ? "Link an empty repository to keep these project files. Import an existing repository from Projects."
          : "Import a public or private repository, including its git history."}
      </p>
      <Button size="sm" type="submit" disabled={disabled || busy}>
        {busy
          ? "Connecting…"
          : provider && !accounts[provider]
            ? `Authorize ${provider === "github" ? "GitHub" : "GitLab"}`
            : mode === "import"
              ? "Import repository"
              : "Link repository"}
      </Button>
      <div className="flex flex-wrap gap-2">
        {(["github", "gitlab"] satisfies GitProvider[]).map((p) => (
          <Button
            key={p}
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || busy}
            onClick={() => void authorize(p)}
          >
            {accounts[p] ? "Reconnect" : "Connect"}{" "}
            {p === "github" ? "GitHub" : "GitLab"}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </form>
  );
}
