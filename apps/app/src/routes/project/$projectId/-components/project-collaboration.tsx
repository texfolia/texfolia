import { IconRefresh } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@texfolia/ui/context-menu";
import { Input } from "@texfolia/ui/input";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getProjectAccess,
  grantProjectAccess,
  revokeProjectAccess,
} from "#/lib/sharing/project-sharing.functions";
import { grantProjectAccessSchema } from "#/lib/sharing/project-sharing.schema";
import { useWorkspaceActions } from "#/providers/workspace-provider";

import { ProjectShareLinks } from "./project-share-links";

type Person = Awaited<ReturnType<typeof getProjectAccess>>["people"][number];

export function ProjectCollaboration() {
  const { projectId } = useWorkspaceActions();
  return <ProjectAccessPanel projectId={projectId} />;
}

export function ProjectAccessPanel({ projectId }: { projectId: string }) {
  const [access, setAccess] =
    useState<Awaited<ReturnType<typeof getProjectAccess>>>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const refresh = useCallback(async () => {
    setError("");
    try {
      setAccess(await getProjectAccess({ data: { projectId } }));
    } catch {
      setError("Could not load project access. Refresh to try again.");
    }
  }, [projectId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function run(action: () => Promise<string | void>, notice?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const nextNotice = await action();
      await refresh();
      setNotice(nextNotice ?? notice ?? "");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Access could not be updated. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function setRole(person: Person, role: "viewer" | "editor") {
    const { email } = person;
    if (!email) return;
    void run(async () => {
      await grantProjectAccess({ data: { projectId, email, role } });
    }, `Access updated for ${person.name}.`);
  }
  return (
    <section aria-label="Project access" className="text-xs">
      <div className="flex h-8 items-center justify-between border-b px-2">
        <h3 className="font-medium">Project access</h3>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh project access"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <IconRefresh />
        </Button>
      </div>
      {!access && !error && (
        <p role="status" className="text-muted-foreground p-2">
          Loading collaborators…
        </p>
      )}
      <ul className="divide-y">
        {access?.people.map((person) => (
          <li key={person.id}>
            <ContextMenu>
              <ContextMenuTrigger
                render={<div />}
                className="flex items-center gap-2 px-2 py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate"
                    title={person.email ?? undefined}
                  >
                    {person.name}
                  </span>
                  <span className="text-muted-foreground">
                    {person.role === "viewer"
                      ? "Can view"
                      : person.role === "editor"
                        ? "Can edit"
                        : person.role}
                  </span>
                </span>
                {access.canManage && person.role !== "owner" && (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    aria-label={`Remove ${person.name}`}
                    onClick={() =>
                      void run(
                        () =>
                          revokeProjectAccess({
                            data: { projectId, userId: person.id },
                          }),
                        `Access removed for ${person.name}.`,
                      )
                    }
                  >
                    Remove
                  </Button>
                )}
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem disabled>
                  {" "}
                  {person.name} · {person.role}
                </ContextMenuItem>
                {access.canManage && person.role !== "owner" && (
                  <>
                    <ContextMenuItem
                      disabled={busy || person.role === "viewer"}
                      onClick={() => setRole(person, "viewer")}
                    >
                      Can view
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={busy || person.role === "editor"}
                      onClick={() => setRole(person, "editor")}
                    >
                      Can edit
                    </ContextMenuItem>
                    <ContextMenuItem
                      variant="destructive"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            revokeProjectAccess({
                              data: { projectId, userId: person.id },
                            }),
                          `Access removed for ${person.name}.`,
                        )
                      }
                    >
                      Remove
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          </li>
        ))}
      </ul>
      {access?.canManage && (
        <form
          ref={form}
          aria-label="Share project"
          className="space-y-2 border-t p-2"
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const parsed = grantProjectAccessSchema.safeParse({
              projectId,
              email: fields.get("email"),
              role: fields.get("role"),
            });
            if (!parsed.success) {
              setError("Enter a valid email and choose an access level.");
              return;
            }
            void run(async () => {
              await grantProjectAccess({ data: parsed.data });
              form.current?.reset();
            }, "If that email has a Texfolia account, it now has access.");
          }}
        >
          <label className="block space-y-1">
            <span>Share with an existing account</span>
            <Input
              name="email"
              type="email"
              required
              placeholder="colleague@example.com"
              autoComplete="email"
              disabled={busy}
            />
          </label>
          <div className="flex gap-1">
            <NativeSelect
              name="role"
              aria-label="Project access level"
              disabled={busy}
              className="min-w-0 flex-1"
            >
              <NativeSelectOption value="viewer">Can view</NativeSelectOption>
              <NativeSelectOption value="editor">Can edit</NativeSelectOption>
            </NativeSelect>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Updating…" : "Share"}
            </Button>
          </div>
          <p className="text-muted-foreground">
            Use the same email again to change a person’s role.
          </p>
        </form>
      )}
      {access?.canManage && <ProjectShareLinks projectId={projectId} />}
      {access?.organization && (
        <p className="text-muted-foreground p-2">
          Every organization member can edit this project.
        </p>
      )}
      {access && !access.organization && access.people.length === 1 && (
        <p className="text-muted-foreground px-2 py-1.5">
          Only the owner has access.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive p-2 wrap-anywhere">
          {error}
        </p>
      )}
      <p role="status" className="text-muted-foreground px-2 empty:hidden">
        {notice}
      </p>
    </section>
  );
}
