import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@texfolia/ui/alert-dialog";
import { Button } from "@texfolia/ui/button";
import { Field, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@texfolia/ui/item";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import { useRef, useState } from "react";

import { authClient } from "#/lib/auth/auth-client";
import { getOrganizations } from "#/lib/auth/organization.functions";
import {
  mainOrgRole,
  type OrganizationRole,
  organizationRoleLabels,
  organizationRoleNames,
} from "#/lib/auth/roles";

export const Route = createFileRoute("/settings/organizations")({
  // The router keeps raw search values that a validator omits.
  validateSearch: (
    search: Record<string, unknown>,
  ): { organizationId?: string } => ({
    organizationId:
      typeof search.organizationId === "string" && search.organizationId
        ? search.organizationId
        : undefined,
  }),
  loaderDeps: ({ search }) => ({ organizationId: search.organizationId }),
  loader: ({ deps }) => getOrganizations({ data: deps }),
  head: () => ({ meta: [{ title: "Organizations | Texfolia" }] }),
  component: OrganizationsPage,
  errorComponent: OrganizationError,
});

type Overview = Awaited<ReturnType<typeof getOrganizations>>;
type Organization = NonNullable<Overview["selected"]>;
type Member = Organization["members"][number];

function OrganizationError() {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Organization unavailable</h2>
      <p className="text-muted-foreground text-sm">
        Check your connection and make sure you're a member of the organization.
      </p>
      <div className="flex gap-3">
        <Button onClick={() => void router.invalidate()}>Try again</Button>
        <Button
          variant="outline"
          render={<Link to="/settings/organizations" search={{}} />}
        >
          Your organizations
        </Button>
      </div>
    </div>
  );
}

function OrganizationsPage() {
  const { organizations, selected, userId } = Route.useLoaderData();
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Organizations</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Every member can open and edit an organization's projects. Admins also
          manage members, projects, templates and billing. Owners also manage
          roles and can delete the organization.
        </p>
      </div>
      <nav aria-label="Organization" className="flex flex-wrap gap-3">
        {organizations.map((organization) => (
          <Button
            key={organization.id}
            variant={selected?.id === organization.id ? "default" : "outline"}
            render={
              <Link
                to="/settings/organizations"
                search={{ organizationId: organization.id }}
              />
            }
          >
            {organization.name}
          </Button>
        ))}
        <Button
          variant="outline"
          render={<Link to="/settings/billing" search={{ plan: "team" }} />}
        >
          New organization
        </Button>
      </nav>
      {selected ? (
        <OrganizationSettings
          key={selected.id}
          organization={selected}
          userId={userId}
        />
      ) : (
        <p className="text-sm">You aren't in an organization.</p>
      )}
    </div>
  );
}

type Confirmation =
  | { kind: "remove"; member: Member }
  | { kind: "leave" }
  | { kind: "delete" };

function check(
  result: { error: { message?: string } | null },
  message: string,
) {
  if (result.error) throw new Error(result.error.message || message);
}

function OrganizationSettings({
  organization,
  userId,
}: {
  organization: Organization;
  userId: string;
}) {
  const router = useRouter();
  const navigate = Route.useNavigate();
  const organizationId = organization.id;
  const role = mainOrgRole(organization.role);
  const isOwner = role === "owner";
  const canManage = role !== "member";
  const owners = organization.members.filter(
    (member) => mainOrgRole(member.role) === "owner",
  ).length;
  const [name, setName] = useState(organization.name);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrganizationRole>("member");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [typedName, setTypedName] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  async function run(action: () => Promise<string | void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    setStatus("");
    try {
      setStatus((await action()) ?? "");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The organization could not be updated. Try again.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function confirm(next: Confirmation) {
    setError("");
    setTypedName("");
    setConfirmation(next);
  }

  function setRole(member: Member, next: OrganizationRole) {
    void run(async () => {
      check(
        await authClient.organization.updateMemberRole({
          organizationId,
          memberId: member.id,
          role: next,
        }),
        "The role could not be changed. Try again.",
      );
      await router.invalidate();
      return `${member.name} is now ${next === "member" ? "a" : "an"} ${next}.`;
    });
  }

  /** Runs after the user is no longer in the organization. */
  async function left() {
    setConfirmation(null);
    await navigate({ search: {}, replace: true });
    await router.invalidate();
  }

  const canRemove = (member: Member) =>
    member.userId !== userId &&
    (isOwner || (canManage && mainOrgRole(member.role) === "member"));

  return (
    <div className="space-y-5">
      {error && !confirmation && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <p role="status" className="text-muted-foreground text-sm empty:sr-only">
        {status}
      </p>
      {canManage && (
        <Item variant="outline">
          <ItemContent className="gap-4">
            <ItemTitle>Name</ItemTitle>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  check(
                    await authClient.organization.update({
                      organizationId,
                      data: { name: name.trim() },
                    }),
                    "The organization could not be renamed. Try again.",
                  );
                  await router.invalidate();
                  return "Organization renamed.";
                });
              }}
            >
              <Field>
                <FieldLabel htmlFor="organization-name">
                  Organization name
                </FieldLabel>
                <Input
                  id="organization-name"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="outline"
                disabled={
                  pending || !name.trim() || name.trim() === organization.name
                }
              >
                Rename
              </Button>
            </form>
          </ItemContent>
        </Item>
      )}
      <Item variant="outline">
        <ItemContent className="gap-4">
          <ItemTitle>Members</ItemTitle>
          <ItemDescription>
            With a Team subscription, every member is a paid seat. Seat changes
            are prorated.{" "}
            <Link
              to="/settings/billing"
              search={{ organizationId }}
              className="underline underline-offset-4"
            >
              Billing
            </Link>
          </ItemDescription>
          <ul className="divide-y">
            {organization.members.map((member) => {
              const memberRole = mainOrgRole(member.role);
              // The server refuses to demote the last owner, too.
              const lastOwner = memberRole === "owner" && owners === 1;
              return (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="wrap-anywhere">
                      {member.name}
                      {member.userId === userId ? " (you)" : ""}
                    </p>
                    <p className="text-muted-foreground text-sm wrap-anywhere">
                      {member.email}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isOwner ? (
                      <NativeSelect
                        size="sm"
                        aria-label={`Role of ${member.name}`}
                        value={memberRole}
                        disabled={pending || lastOwner}
                        onChange={(event) => {
                          const next = organizationRoleNames.find(
                            (name) => name === event.target.value,
                          );
                          if (next) setRole(member, next);
                        }}
                      >
                        {organizationRoleNames.map((name) => (
                          <NativeSelectOption key={name} value={name}>
                            {organizationRoleLabels[name]}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        {organizationRoleLabels[memberRole]}
                      </span>
                    )}
                    {canRemove(member) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        aria-label={`Remove ${member.name}`}
                        onClick={() => confirm({ kind: "remove", member })}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {canManage && (
            <form
              className="space-y-4 border-t pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  check(
                    await authClient.organization.inviteMember({
                      organizationId,
                      email: email.trim(),
                      role: inviteRole,
                    }),
                    "The invitation could not be sent. Try again.",
                  );
                  setEmail("");
                  setInviteRole("member");
                  await router.invalidate();
                  return "Invitation sent. A seat will be added when it is accepted.";
                });
              }}
            >
              <div className="flex flex-wrap items-end gap-3">
                <Field className="min-w-0 flex-1 basis-60">
                  <FieldLabel htmlFor="member-email">
                    Invite by email
                  </FieldLabel>
                  <Input
                    id="member-email"
                    type="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
                {isOwner && (
                  <NativeSelect
                    aria-label="Role of the invited person"
                    value={inviteRole}
                    onChange={(event) =>
                      setInviteRole(
                        organizationRoleNames.find(
                          (name) => name === event.target.value,
                        ) ?? "member",
                      )
                    }
                  >
                    {organizationRoleNames.map((name) => (
                      <NativeSelectOption key={name} value={name}>
                        {organizationRoleLabels[name]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
                <Button type="submit" variant="outline" disabled={pending}>
                  Send invitation
                </Button>
              </div>
            </form>
          )}
          {organization.invitations.length > 0 && (
            <ul aria-label="Pending invitations" className="space-y-3">
              {organization.invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-wrap items-center justify-between gap-3 text-sm"
                >
                  <span className="wrap-anywhere">
                    {invitation.email} · Invited as{" "}
                    {organizationRoleLabels[
                      mainOrgRole(invitation.role ?? "member")
                    ].toLowerCase()}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    aria-label={`Cancel invitation of ${invitation.email}`}
                    onClick={() =>
                      void run(async () => {
                        check(
                          await authClient.organization.cancelInvitation({
                            invitationId: invitation.id,
                          }),
                          "The invitation could not be canceled. Try again.",
                        );
                        await router.invalidate();
                        return "Invitation canceled.";
                      })
                    }
                  >
                    Cancel invitation
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </ItemContent>
      </Item>
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>Leave organization</ItemTitle>
          <ItemDescription>
            {isOwner && owners === 1
              ? "You are the only owner. Make someone else an owner first, or delete the organization."
              : "You lose access to its projects. Your personal projects are kept."}
          </ItemDescription>
          <Button
            variant="outline"
            className="mt-4 w-fit"
            disabled={pending || (isOwner && owners === 1)}
            onClick={() => confirm({ kind: "leave" })}
          >
            Leave organization
          </Button>
        </ItemContent>
      </Item>
      {isOwner && (
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>Delete organization</ItemTitle>
            <ItemDescription>
              Permanently deletes the organization, its{" "}
              {counted(organization.projectCount, "project")} (including the
              trash) and its {counted(organization.templateCount, "template")}.
              Cancel its subscription in Billing first.
            </ItemDescription>
            <Button
              variant="destructive"
              className="mt-4 w-fit"
              disabled={pending}
              onClick={() => confirm({ kind: "delete" })}
            >
              Delete organization
            </Button>
          </ItemContent>
        </Item>
      )}
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          {confirmation?.kind === "remove" && (
            <ConfirmationBody
              title={`Remove ${confirmation.member.name}?`}
              description={`They lose access to ${organization.name}'s projects, and the seat count is updated.`}
              error={error}
              pending={pending}
              action="Remove member"
              onCancel={() => setConfirmation(null)}
              onConfirm={() =>
                void run(async () => {
                  check(
                    await authClient.organization.removeMember({
                      organizationId,
                      memberIdOrEmail: confirmation.member.id,
                    }),
                    "The member could not be removed. Try again.",
                  );
                  setConfirmation(null);
                  await router.invalidate();
                  return "Member removed. Billing follows current membership.";
                })
              }
            />
          )}
          {confirmation?.kind === "leave" && (
            <ConfirmationBody
              title={`Leave ${organization.name}?`}
              description="You lose access to its projects until someone invites you again."
              error={error}
              pending={pending}
              action="Leave organization"
              onCancel={() => setConfirmation(null)}
              onConfirm={() =>
                void run(async () => {
                  check(
                    await authClient.organization.leave({ organizationId }),
                    "You could not leave the organization. Try again.",
                  );
                  await left();
                })
              }
            />
          )}
          {confirmation?.kind === "delete" && (
            <ConfirmationBody
              title={`Delete ${organization.name}?`}
              description="Its projects and templates are deleted for every member. This cannot be undone."
              error={error}
              pending={pending}
              disabled={typedName !== organization.name}
              action="Delete organization"
              onCancel={() => setConfirmation(null)}
              onConfirm={() =>
                void run(async () => {
                  check(
                    await authClient.organization.delete({ organizationId }),
                    "The organization could not be deleted. Try again.",
                  );
                  await left();
                })
              }
            >
              <Field>
                <FieldLabel htmlFor="delete-organization-name">
                  Type {organization.name} to confirm
                </FieldLabel>
                <Input
                  id="delete-organization-name"
                  autoComplete="off"
                  value={typedName}
                  onChange={(event) => setTypedName(event.target.value)}
                />
              </Field>
            </ConfirmationBody>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function counted(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function ConfirmationBody({
  title,
  description,
  error,
  pending,
  disabled = false,
  action,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  description: string;
  error: string;
  pending: boolean;
  disabled?: boolean;
  action: string;
  onCancel: () => void;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  return (
    <>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription>{description}</AlertDialogDescription>
      {children}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <AlertDialogFooter>
        <Button variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={pending || disabled}
          onClick={onConfirm}
        >
          {pending ? "Working…" : action}
        </Button>
      </AlertDialogFooter>
    </>
  );
}
