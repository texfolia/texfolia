import { useNavigate } from "@tanstack/react-router";
import { Button } from "@texfolia/ui/button";
import { Field, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import { useId, useState } from "react";

import { projectNameSchema } from "#/features/projects";
import { openTemplate } from "#/lib/template.functions";
import { useProjects } from "#/providers/projects-provider";

export function ProjectForm({
  template,
  destinations,
  onPendingChange,
}: {
  template: { id: string; title: string } | null;
  destinations: { id: string; name: string }[];
  onPendingChange: (pending: boolean) => void;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const nameId = useId();
  const [name, setName] = useState(template?.title ?? "");
  const [organizationId, setOrganizationId] = useState("");
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
          const id = template
            ? (
                await openTemplate({
                  data: {
                    templateId: template.id,
                    organizationId: organizationId || null,
                    name: parsed.data,
                  },
                })
              ).id
            : await projects.create(parsed.data);
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
      {template && destinations.length > 0 && (
        <label className="space-y-2 text-sm">
          <span>Create in</span>
          <NativeSelect
            aria-label="Create in"
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            disabled={pending}
            className="w-full"
          >
            <NativeSelectOption value="">Personal account</NativeSelectOption>
            {destinations.map((destination) => (
              <NativeSelectOption key={destination.id} value={destination.id}>
                {destination.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      )}
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
