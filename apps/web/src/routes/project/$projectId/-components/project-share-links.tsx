import { IconCopy, IconLink } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import {
  projectRoleLabels,
  projectRoles,
  type ProjectRole,
} from "#/lib/projects/roles";
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
} from "#/lib/sharing/project-share-links.functions";
import {
  createShareLinkSchema,
  projectRoleSchema,
} from "#/lib/sharing/project-share-links.schema";
import { sharePath } from "#/lib/sharing/share-token";

const roleOptions = [...projectRoles].reverse();

type Links = Awaited<ReturnType<typeof listShareLinks>>["links"];

export function ProjectShareLinks({ projectId }: { projectId: string }) {
  const [links, setLinks] = useState<Links>();
  const [role, setRole] = useState<ProjectRole>("viewer");
  const [recipientEmail, setRecipientEmail] = useState("");
  // The full link is only available right after creation.
  const [created, setCreated] = useState<{ id: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    try {
      setLinks((await listShareLinks({ data: { projectId } })).links);
    } catch {
      setError("Could not load share links. Refresh to try again.");
    }
  }, [projectId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setNotice(await action());
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Share links could not be updated. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied.");
    } catch {
      setError("Copy failed. Select the link and copy it manually.");
    }
  }

  return (
    <div
      aria-label="Share links"
      role="group"
      className="space-y-2 border-t p-2"
    >
      <h3 className="flex items-center gap-1.5 font-medium">
        <IconLink className="size-3.5" aria-hidden />
        Share links
      </h3>
      <p className="text-muted-foreground">
        Anyone with a view link can open the project without signing in. Comment
        and edit links ask people to sign in first. Links don’t expire; revoking
        one ends access for everyone who used it.
      </p>
      {links && links.length > 0 && (
        <ul className="divide-y rounded-sm border">
          {links.map((link) => (
            <li key={link.id} className="space-y-1 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block">{projectRoleLabels[link.role]}</span>
                  <span className="text-muted-foreground">
                    Created {new Date(link.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  aria-label={`Revoke ${projectRoleLabels[link.role]} link created ${new Date(link.createdAt).toLocaleString()}`}
                  onClick={() =>
                    void run(async () => {
                      await revokeShareLink({
                        data: { projectId, linkId: link.id },
                      });
                      if (created?.id === link.id) setCreated(undefined);
                      return "Link revoked. It stops working right away.";
                    })
                  }
                >
                  Revoke
                </Button>
              </div>
              {created?.id === link.id && (
                <div className="flex gap-1">
                  <Input
                    readOnly
                    value={created.url}
                    aria-label="New share link"
                    onFocus={(event) => event.currentTarget.select()}
                    className="min-w-0 flex-1"
                  />
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Copy share link"
                    onClick={() => void copy(created.url)}
                  >
                    <IconCopy />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        aria-label="Create share link"
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedEmail = recipientEmail.trim();
          const parsed = createShareLinkSchema.safeParse({
            projectId,
            role,
            ...(trimmedEmail ? { recipientEmail: trimmedEmail } : {}),
          });
          if (!parsed.success) {
            setError(
              "Enter a valid email address, or leave it blank to create a link without emailing anyone.",
            );
            return;
          }
          void run(async () => {
            const link = await createShareLink({ data: parsed.data });
            const url = new URL(sharePath(link.token), window.location.origin)
              .href;
            setCreated({ id: link.id, url });
            setRecipientEmail("");
            await navigator.clipboard.writeText(url).catch(() => {});
            if (link.notification === "queued")
              return `Link created. We’re emailing it to ${parsed.data.recipientEmail}. Copy it now if you also need it; it won’t be shown again.`;
            if (link.notification === "failed")
              return "Link created, but the email could not be sent. Copy it now; it won’t be shown again.";
            return "Link created. Copy it now; it won’t be shown again.";
          });
        }}
      >
        <label className="block space-y-1">
          <span>Email link to (optional)</span>
          <Input
            name="recipientEmail"
            type="email"
            placeholder="reviewer@example.com"
            autoComplete="email"
            value={recipientEmail}
            disabled={busy}
            onChange={(event) => setRecipientEmail(event.target.value)}
          />
        </label>
        <div className="flex gap-1">
          <NativeSelect
            aria-label="Share link access"
            value={role}
            disabled={busy}
            onChange={(event) => {
              const parsed = projectRoleSchema.safeParse(event.target.value);
              if (parsed.success) setRole(parsed.data);
            }}
            className="min-w-0 flex-1"
          >
            {roleOptions.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {projectRoleLabels[option]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="submit" size="sm" disabled={busy}>
            {busy
              ? "Working…"
              : recipientEmail.trim()
                ? "Create & email"
                : "Create link"}
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-destructive wrap-anywhere">
          {error}
        </p>
      )}
      <p role="status" className="text-muted-foreground empty:hidden">
        {notice}
      </p>
    </div>
  );
}
