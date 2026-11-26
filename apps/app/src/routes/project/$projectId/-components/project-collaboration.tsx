import { IconRefresh } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { Input } from "@texfolia/ui/input";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  projectRoleLabels,
  projectRoles,
  type ProjectRole,
} from "#/lib/projects/roles";
import {
  getProjectAccess,
  grantProjectAccess,
  grantTeamAccess,
  revokeProjectAccess,
  revokeTeamAccess,
  setOrganizationRole,
} from "#/lib/sharing/project-sharing.functions";
import { grantProjectAccessSchema } from "#/lib/sharing/project-sharing.schema";
import { useWorkspaceActions } from "#/providers/workspace-provider";

import { ProjectShareLinks } from "./project-share-links";

type Access = Awaited<ReturnType<typeof getProjectAccess>>;
type Person = Access["people"][number];

// Most access first, as in Google Docs.
const roleOptions = [...projectRoles].reverse();

export function ProjectCollaboration() {
  const { projectId } = useWorkspaceActions();
  return <ProjectAccessPanel projectId={projectId} />;
}

function RoleSelect({
  label,
  value,
  disabled,
  none,
  onChange,
}: {
  label: string;
  value: ProjectRole | null;
  disabled: boolean;
  // The label for no access, when it is a choice.
  none?: string;
  onChange: (role: ProjectRole | null) => void;
}) {
  return (
    <NativeSelect
      aria-label={label}
      value={value ?? ""}
      disabled={disabled}
      size="sm"
      onChange={(event) =>
        onChange((event.target.value || null) as ProjectRole | null)
      }
    >
      {none !== undefined && (
        <NativeSelectOption value="">{none}</NativeSelectOption>
      )}
      {roleOptions.map((role) => (
        <NativeSelectOption key={role} value={role}>
          {projectRoleLabels[role]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

export function ProjectAccessPanel({ projectId }: { projectId: string }) {
  const [access, setAccess] = useState<Access>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const teamForm = useRef<HTMLFormElement>(null);
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
  function setRole(person: Person, role: ProjectRole) {
    const { email } = person;
    if (!email) return;
    void run(async () => {
      await grantProjectAccess({ data: { projectId, email, role } });
    }, `Access updated for ${person.name}.`);
  }
  function remove(person: Person) {
    void run(
      () => revokeProjectAccess({ data: { projectId, userId: person.id } }),
      `Access removed for ${person.name}.`,
    );
  }
  const canManage = !!access?.canManage;
  const organization = access?.organization;
  const grantedTeams = organization?.teams.filter((team) => team.role) ?? [];
  const otherTeams = organization?.teams.filter((team) => !team.role) ?? [];
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
      <ul className="divide-y" aria-label="People and teams with access">
        {access?.owner && (
          <li className="flex items-center gap-2 px-2 py-1.5">
            <span className="min-w-0 flex-1">
              <span
                className="block truncate"
                title={access.owner.email ?? undefined}
              >
                {access.owner.name}
              </span>
              <span className="text-muted-foreground">Owner</span>
            </span>
          </li>
        )}
        {organization && (
          <>
            <li className="flex items-center gap-2 px-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  Owners and admins of {organization.name}
                </span>
                <span className="text-muted-foreground">
                  Can edit and manage access
                </span>
              </span>
            </li>
            <li className="flex items-center gap-2 px-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  Everyone in {organization.name}
                </span>
                {!canManage && (
                  <span className="text-muted-foreground">
                    {organization.role
                      ? projectRoleLabels[organization.role]
                      : "No access unless added"}
                  </span>
                )}
              </span>
              {canManage && (
                <RoleSelect
                  label={`Access for everyone in ${organization.name}`}
                  value={organization.role}
                  none="No access"
                  disabled={busy}
                  onChange={(role) =>
                    void run(
                      () => setOrganizationRole({ data: { projectId, role } }),
                      "Organization access updated.",
                    )
                  }
                />
              )}
            </li>
            {grantedTeams.map((team) => (
              <li key={team.id} className="flex items-center gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{team.name}</span>
                  <span className="text-muted-foreground">
                    {canManage
                      ? "Team"
                      : `Team · ${team.role && projectRoleLabels[team.role]}`}
                  </span>
                </span>
                {canManage && team.role && (
                  <>
                    <RoleSelect
                      label={`Access for team ${team.name}`}
                      value={team.role}
                      disabled={busy}
                      onChange={(role) =>
                        role &&
                        void run(
                          () =>
                            grantTeamAccess({
                              data: { projectId, teamId: team.id, role },
                            }),
                          `Access updated for ${team.name}.`,
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      aria-label={`Remove team ${team.name}`}
                      onClick={() =>
                        void run(
                          () =>
                            revokeTeamAccess({
                              data: { projectId, teamId: team.id },
                            }),
                          `Access removed for ${team.name}.`,
                        )
                      }
                    >
                      Remove
                    </Button>
                  </>
                )}
              </li>
            ))}
          </>
        )}
        {access?.people.map((person) => (
          <li key={person.id} className="flex items-center gap-2 px-2 py-1.5">
            <span className="min-w-0 flex-1">
              <span
                className="block truncate"
                title={person.email ?? undefined}
              >
                {person.name}
              </span>
              {!canManage && (
                <span className="text-muted-foreground">
                  {projectRoleLabels[person.role]}
                </span>
              )}
            </span>
            {canManage && (
              <>
                <RoleSelect
                  label={`Access for ${person.name}`}
                  value={person.role}
                  disabled={busy}
                  onChange={(role) => role && setRole(person, role)}
                />
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  aria-label={`Remove ${person.name}`}
                  onClick={() => remove(person)}
                >
                  Remove
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
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
            void run(
              async () => {
                await grantProjectAccess({ data: parsed.data });
                form.current?.reset();
              },
              organization
                ? "If that email belongs to a member, they now have access."
                : "If that email has a Texfolia account, it now has access.",
            );
          }}
        >
          <label className="block space-y-1">
            <span>
              {organization
                ? `Share with a member of ${organization.name}`
                : "Share with an existing account"}
            </span>
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
              defaultValue="viewer"
              disabled={busy}
              className="min-w-0 flex-1"
            >
              {roleOptions.map((role) => (
                <NativeSelectOption key={role} value={role}>
                  {projectRoleLabels[role]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Updating…" : "Share"}
            </Button>
          </div>
          <p className="text-muted-foreground">
            Commenters can add and resolve comments but not edit files. Use the
            same email again to change a person’s role.
          </p>
        </form>
      )}
      {canManage && otherTeams.length > 0 && (
        <form
          ref={teamForm}
          aria-label="Share with a team"
          className="space-y-2 border-t p-2"
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const teamId = String(fields.get("team") ?? "");
            const role = fields.get("role") as ProjectRole;
            const team = otherTeams.find((item) => item.id === teamId);
            if (!team) return;
            void run(async () => {
              await grantTeamAccess({ data: { projectId, teamId, role } });
              teamForm.current?.reset();
            }, `${team.name} now has access.`);
          }}
        >
          <span className="block">Share with a team</span>
          <div className="flex gap-1">
            <NativeSelect
              name="team"
              aria-label="Team"
              disabled={busy}
              className="min-w-0 flex-1"
            >
              {otherTeams.map((team) => (
                <NativeSelectOption key={team.id} value={team.id}>
                  {team.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              name="role"
              aria-label="Team access level"
              defaultValue="viewer"
              disabled={busy}
            >
              {roleOptions.map((role) => (
                <NativeSelectOption key={role} value={role}>
                  {projectRoleLabels[role]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button type="submit" size="sm" disabled={busy}>
              Add
            </Button>
          </div>
        </form>
      )}
      {canManage && <ProjectShareLinks projectId={projectId} />}
      {access &&
        !organization &&
        access.people.length === 0 &&
        access.owner && (
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
