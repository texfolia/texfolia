"use client";

import { useNavigate } from "@tanstack/react-router";
import { useId, useState, type FormEvent } from "react";
import { z } from "zod";

import { Button } from "#/components/ui/button";
import { Field, FieldError, FieldLabel } from "#/components/ui/field";
import { Form } from "#/components/ui/form";
import { Input } from "#/components/ui/input";
import { createProject } from "#/lib/projects.functions";

const schema = z.object({
  name: z.string().trim().min(1, { message: "Please enter a project name." }),
});

type Errors = { name?: string[] };

export function ProjectForm() {
  const navigate = useNavigate();
  const nameId = useId();
  const errorId = `${nameId}-error`;
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;

    const formData = new FormData(event.currentTarget);
    const result = schema.safeParse(Object.fromEntries(formData));
    setSubmitError(null);

    if (!result.success) {
      setErrors(z.flattenError(result.error).fieldErrors);
      return;
    }

    setErrors({});
    setLoading(true);

    try {
      const [project] = await createProject({ data: result.data });
      if (!project) throw new Error("Project creation returned no project.");

      await navigate({
        to: "/projects/$projectId",
        params: { projectId: project.id },
      });
    } catch {
      setSubmitError("Unable to create your project. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Form className="flex w-full flex-col gap-4" errors={errors} onSubmit={onSubmit}>
      <Field data-invalid={Boolean(errors.name?.length)}>
        <FieldLabel htmlFor={nameId}>Project Name</FieldLabel>
        <Input
          id={nameId}
          name="name"
          placeholder="My Project"
          disabled={loading}
          aria-invalid={Boolean(errors.name?.length)}
          aria-describedby={errors.name?.length ? errorId : undefined}
          onChange={() => setErrors({})}
        />
        <FieldError
          id={errorId}
          errors={errors.name?.map((message) => ({ message }))}
        />
      </Field>
      {submitError && <FieldError>{submitError}</FieldError>}
      <Button loading={loading} type="submit">
        Create Project
      </Button>
    </Form>
  );
}
