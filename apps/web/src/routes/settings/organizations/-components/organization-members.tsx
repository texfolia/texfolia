import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "#/components/ui/item";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { authClient } from "#/lib/auth/auth-client";
import {
  mainOrgRole,
  type OrganizationRole,
  organizationRoleLabels,
  organizationRoleNames,
} from "#/lib/auth/roles";

import { check, type Member, type OrganizationState } from "./use-organization";

export function OrganizationMembers({ org }: { org: OrganizationState }) {
  const { organization, canManage } = org;
  return (
    <Item variant="outline">
      <ItemContent className="gap-4">
        <ItemTitle>Members</ItemTitle>
        <ItemDescription>
          With a Team subscription, every member is a paid seat. Seat changes
          are prorated.{" "}
          <Link
            to="/settings/billing"
            search={{ organizationId: organization.id }}
            className="underline underline-offset-4"
          >
            Billing
          </Link>
        </ItemDescription>
        <ul className="divide-y">
          {organization.members.map((member) => (
            <MemberRow key={member.id} org={org} member={member} />
          ))}
        </ul>
        {canManage && <InviteForm org={org} />}
        {organization.invitations.length > 0 && <Invitations org={org} />}
      </ItemContent>
    </Item>
  );
}

function MemberRow({
  org,
  member,
}: {
  org: OrganizationState;
  member: Member;
}) {
  const { isOwner, canManage, owners, pending, userId } = org;
  const memberRole = mainOrgRole(member.role);
  // The server refuses to demote the last owner, too.
  const lastOwner = memberRole === "owner" && owners === 1;
  const canRemove =
    member.userId !== userId &&
    (isOwner || (canManage && memberRole === "member"));

  function setRole(next: OrganizationRole) {
    void org.run(async () => {
      check(
        await authClient.organization.updateMemberRole({
          organizationId: org.organization.id,
          memberId: member.id,
          role: next,
        }),
        "The role could not be changed. Try again.",
      );
      await org.refresh();
      return `${member.name} is now ${next === "member" ? "a" : "an"} ${next}.`;
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
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
              if (next) setRole(next);
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
        {canRemove && (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            aria-label={`Remove ${member.name}`}
            onClick={() => org.confirm({ kind: "remove", member })}
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}

function InviteForm({ org }: { org: OrganizationState }) {
  const { isOwner, pending, run, refresh } = org;
  const organizationId = org.organization.id;
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrganizationRole>("member");
  return (
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
          await refresh();
          return "Invitation sent. A seat will be added when it is accepted.";
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-0 flex-1 basis-60">
          <FieldLabel htmlFor="member-email">Invite by email</FieldLabel>
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
  );
}

function Invitations({ org }: { org: OrganizationState }) {
  const { organization, pending, run, refresh } = org;
  return (
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
                await refresh();
                return "Invitation canceled.";
              })
            }
          >
            Cancel invitation
          </Button>
        </li>
      ))}
    </ul>
  );
}
