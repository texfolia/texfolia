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
import { type ReactNode, useState } from "react";

import { authClient } from "#/lib/auth/auth-client";

import { check, type OrganizationState } from "./use-organization";

/** Asks before a member is removed or leaves, or the organization is deleted. */
export function OrganizationConfirmation({ org }: { org: OrganizationState }) {
  const { organization, confirmation, error, pending, run, refresh } = org;
  const close = org.closeConfirmation;
  return (
    <AlertDialog
      open={!!confirmation}
      onOpenChange={(open) => {
        if (!open && !pending) close();
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
            onCancel={close}
            onConfirm={() =>
              void run(async () => {
                check(
                  await authClient.organization.removeMember({
                    organizationId: organization.id,
                    memberIdOrEmail: confirmation.member.id,
                  }),
                  "The member could not be removed. Try again.",
                );
                close();
                await refresh();
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
            onCancel={close}
            onConfirm={() =>
              void run(async () => {
                check(
                  await authClient.organization.leave({
                    organizationId: organization.id,
                  }),
                  "You could not leave the organization. Try again.",
                );
                await org.left();
              })
            }
          />
        )}
        {confirmation?.kind === "delete" && <DeleteOrganization org={org} />}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Asks for the organization's name, too. */
function DeleteOrganization({ org }: { org: OrganizationState }) {
  const { organization, error, pending, run } = org;
  const close = org.closeConfirmation;
  const [typedName, setTypedName] = useState("");
  return (
    <ConfirmationBody
      title={`Delete ${organization.name}?`}
      description="Its projects and templates are deleted for every member. This cannot be undone."
      error={error}
      pending={pending}
      disabled={typedName !== organization.name}
      action="Delete organization"
      onCancel={close}
      onConfirm={() =>
        void run(async () => {
          check(
            await authClient.organization.delete({
              organizationId: organization.id,
            }),
            "The organization could not be deleted. Try again.",
          );
          await org.left();
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
  );
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
  children?: ReactNode;
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
