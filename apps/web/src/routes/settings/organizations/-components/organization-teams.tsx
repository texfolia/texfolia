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
import { useState } from "react";

import { authClient } from "#/lib/auth/auth-client";

import { check, type OrganizationState } from "./use-organization";

type Team = OrganizationState["organization"]["teams"][number];

// Teams group members so a project can be shared with all of them at once,
// from the project's sharing panel. Owners and admins manage them.
export function OrganizationTeams({ org }: { org: OrganizationState }) {
  const { organization, canManage, pending } = org;
  const [name, setName] = useState("");
  if (!canManage && organization.teams.length === 0) return null;
  return (
    <Item variant="outline">
      <ItemContent className="gap-4">
        <ItemTitle>Teams</ItemTitle>
        <ItemDescription>
          Share a project with a team from the project’s access panel. Members
          get the team’s access for as long as they’re on it.
        </ItemDescription>
        {organization.teams.length > 0 ? (
          <ul className="divide-y">
            {organization.teams.map((team) => (
              <TeamRow key={team.id} org={org} team={team} />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No teams yet.</p>
        )}
        {canManage && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const teamName = name.trim();
              if (!teamName) return;
              void org.run(async () => {
                check(
                  await authClient.organization.createTeam({
                    name: teamName,
                    organizationId: organization.id,
                  }),
                  "The team could not be created. Try again.",
                );
                setName("");
                await org.refresh();
                return `Team ${teamName} created.`;
              });
            }}
          >
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor="new-team-name">New team</FieldLabel>
              <Input
                id="new-team-name"
                maxLength={100}
                placeholder="Reviewers"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="outline"
              disabled={pending || !name.trim()}
            >
              Create team
            </Button>
          </form>
        )}
      </ItemContent>
    </Item>
  );
}

function TeamRow({ org, team }: { org: OrganizationState; team: Team }) {
  const { organization, canManage, pending } = org;
  const members = organization.members.filter((member) =>
    team.userIds.includes(member.userId),
  );
  const others = organization.members.filter(
    (member) => !team.userIds.includes(member.userId),
  );
  const [adding, setAdding] = useState("");
  function change(action: () => Promise<string>) {
    void org.run(async () => {
      const message = await action();
      await org.refresh();
      return message;
    });
  }
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium wrap-anywhere">{team.name}</p>
        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            aria-label={`Delete team ${team.name}`}
            onClick={() =>
              change(async () => {
                check(
                  await authClient.organization.removeTeam({
                    teamId: team.id,
                    organizationId: organization.id,
                  }),
                  "The team could not be deleted. Try again.",
                );
                return `Team ${team.name} deleted. Its members lost the access it gave them.`;
              })
            }
          >
            Delete
          </Button>
        )}
      </div>
      {members.length > 0 ? (
        <ul className="text-sm" aria-label={`Members of ${team.name}`}>
          {members.map((member) => (
            <li
              key={member.userId}
              className="flex items-center justify-between gap-2 py-1"
            >
              <span className="wrap-anywhere">{member.name}</span>
              {canManage && (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={pending}
                  aria-label={`Remove ${member.name} from ${team.name}`}
                  onClick={() =>
                    change(async () => {
                      check(
                        await authClient.organization.removeTeamMember({
                          teamId: team.id,
                          userId: member.userId,
                          organizationId: organization.id,
                        }),
                        "The member could not be removed. Try again.",
                      );
                      return `${member.name} left ${team.name}.`;
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No members.</p>
      )}
      {canManage && others.length > 0 && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const member = others.find((item) => item.userId === adding);
            if (!member) return;
            change(async () => {
              check(
                await authClient.organization.addTeamMember({
                  teamId: team.id,
                  userId: member.userId,
                  organizationId: organization.id,
                }),
                "The member could not be added. Try again.",
              );
              setAdding("");
              return `${member.name} joined ${team.name}.`;
            });
          }}
        >
          <NativeSelect
            size="sm"
            aria-label={`Add a member to ${team.name}`}
            value={adding}
            disabled={pending}
            onChange={(event) => setAdding(event.target.value)}
          >
            <NativeSelectOption value="">Add a member…</NativeSelectOption>
            {others.map((member) => (
              <NativeSelectOption key={member.userId} value={member.userId}>
                {member.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={pending || !adding}
          >
            Add
          </Button>
        </form>
      )}
    </li>
  );
}
