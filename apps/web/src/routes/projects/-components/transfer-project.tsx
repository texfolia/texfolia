import { useEffect, useId, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { toast } from "#/components/ui/toast";
import type { Project } from "#/lib/projects/project.functions";
import {
  getProjectAccess,
  transferProject,
} from "#/lib/sharing/project-sharing.functions";
import { useProjects } from "#/providers/projects-provider";

type Person = Pick<
  Awaited<ReturnType<typeof getProjectAccess>>["people"][number],
  "id" | "name" | "email"
>;

export function TransferProject({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const store = useProjects();
  const id = useId();
  const [people, setPeople] = useState<Person[]>();
  const [recipientId, setRecipientId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    getProjectAccess({ data: { projectId: project.id } })
      .then((access) => {
        if (active)
          setPeople(
            (access.organization?.members ?? access.people).filter(
              (person) => person.id !== store.ownerId,
            ),
          );
      })
      .catch(() => {
        if (active)
          setError("Could not load people. Close this and try again.");
      });
    return () => {
      active = false;
    };
  }, [project.id, store.ownerId]);
  const recipient = people?.find((person) => person.id === recipientId);
  async function transfer(person: Person) {
    setPending(true);
    setError("");
    try {
      await transferProject({
        data: { projectId: project.id, userId: person.id },
      });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not transfer project. Try again.",
      );
      setPending(false);
      return;
    }
    toast.add({
      title: `${person.name} now owns “${project.name}”`,
      type: "success",
    });
    await store.refresh().catch(() => {});
    onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Transfer ownership</DialogTitle>
          <DialogDescription>
            {project.organizationId
              ? `Move “${project.name}” out of the organization to one of its members.`
              : `Make a collaborator the owner of “${project.name}”.`}
          </DialogDescription>
        </DialogHeader>
        {people?.length === 0 ? (
          <p className="text-sm">
            {project.organizationId
              ? "This organization has no other members."
              : "Share the project with the new owner first, then transfer it."}
          </p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (recipient && !pending) void transfer(recipient);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor={id}>New owner</Label>
              <NativeSelect
                id={id}
                className="w-full"
                required
                disabled={!people || pending}
                value={recipientId}
                onChange={(event) => setRecipientId(event.target.value)}
              >
                <NativeSelectOption value="">
                  {people || error ? "Choose a person" : "Loading people…"}
                </NativeSelectOption>
                {people?.map((person) => (
                  <NativeSelectOption key={person.id} value={person.id}>
                    {person.email
                      ? `${person.name} (${person.email})`
                      : person.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
              <li>
                You keep edit access, which the new owner can change or remove.
              </li>
              <li>
                {project.organizationId
                  ? "Other organization members lose access."
                  : "Share links are revoked. Other collaborators keep access."}
              </li>
              <li>
                {project.organizationId
                  ? "The project cannot be moved back into the organization."
                  : "Only the new owner can transfer it back."}
              </li>
            </ul>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                type="button"
                disabled={pending}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!recipient || pending}>
                {pending ? "Transferring…" : "Transfer ownership"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
