import { useNavigate } from "@tanstack/react-router";
import { Button } from "@texfolia/ui/button";
import { Field, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import { useId, useState } from "react";

import { projectNameSchema } from "#/lib/projects";
import { useProjects } from "#/providers/projects-provider";

export function ProjectForm({
  onPendingChange,
}: {
  onPendingChange: (pending: boolean) => void;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const nameId = useId();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        const parsed = projectNameSchema.safeParse(name);
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Enter a name.");
          return;
        }
        setError("");
        setPending(true);
        onPendingChange(true);
        try {
          const id = await projects.create(parsed.data);
          await navigate({
            to: "/project/$projectId",
            params: { projectId: id },
          });
        } catch {
          setError(
            "Unable to create your project. Try again or choose a different name.",
          );
        } finally {
          setPending(false);
          onPendingChange(false);
        }
      }}
    >
      <Field>
        <FieldLabel htmlFor={nameId}>Project name</FieldLabel>
        <Input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My project"
          required
          disabled={pending}
        />
      </Field>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}
