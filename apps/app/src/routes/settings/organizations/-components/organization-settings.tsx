import { Button } from "@texfolia/ui/button";
import { Field, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@texfolia/ui/item";
import { useState } from "react";

import { authClient } from "#/lib/auth/auth-client";

import { OrganizationConfirmation } from "./organization-confirmation";
import { OrganizationMembers } from "./organization-members";
import { OrganizationTeams } from "./organization-teams";
import {
  check,
  type Organization,
  type OrganizationState,
  useOrganization,
} from "./use-organization";

export function OrganizationSettings({
  organization,
  userId,
}: {
  organization: Organization;
  userId: string;
}) {
  const org = useOrganization(organization, userId);
  const { isOwner, pending, confirm } = org;
  return (
    <div className="space-y-5">
      {org.error && !org.confirmation && (
        <p role="alert" className="text-destructive text-sm">
          {org.error}
        </p>
      )}
      <p role="status" className="text-muted-foreground text-sm empty:sr-only">
        {org.status}
      </p>
      {org.canManage && <OrganizationName org={org} />}
      <OrganizationMembers org={org} />
      <OrganizationTeams org={org} />
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>Leave organization</ItemTitle>
          <ItemDescription>
            {org.soleOwner
              ? "You are the only owner. Make someone else an owner first, or delete the organization."
              : "You lose access to its projects. Your personal projects are kept."}
          </ItemDescription>
          <Button
            variant="outline"
            className="mt-4 w-fit"
            disabled={pending || org.soleOwner}
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
              Permanently deletes the organization and its{" "}
              {counted(organization.projectCount, "project")} (including the
              trash). Cancel its subscription in Billing first.
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
      <OrganizationConfirmation org={org} />
    </div>
  );
}

function OrganizationName({ org }: { org: OrganizationState }) {
  const { organization, pending, run, refresh } = org;
  const [name, setName] = useState(organization.name);
  return (
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
                  organizationId: organization.id,
                  data: { name: name.trim() },
                }),
                "The organization could not be renamed. Try again.",
              );
              await refresh();
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
  );
}

function counted(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
