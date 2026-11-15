"use client";

import { useForm, useStore } from "@tanstack/react-form-start";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { z } from "zod";

import { Button } from "#/components/ui/button";
import { Field, FieldError, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { projectNameSchema } from "#/lib/project.schema";
import { useProjects } from "#/providers/projects-provider";

const schema = z.object({
  name: projectNameSchema,
});

export function ProjectForm() {
  const navigate = useNavigate();
  const projects = useProjects();
  const nameId = useId();
  const errorId = `${nameId}-error`;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: { name: "" },
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      setSubmitError(null);

      try {
        const projectId = await projects.create(value.name);

        await navigate({
          to: "/project/$projectId",
          params: { projectId },
        });
      } catch {
        setSubmitError("Unable to create your project. Please try again.");
      }
    },
  });
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      className="flex w-full flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitError(null);
        void form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => {
          const isInvalid =
            field.state.meta.isTouched && !field.state.meta.isValid;

          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor={nameId}>Project Name</FieldLabel>
              <Input
                id={nameId}
                name={field.name}
                placeholder="My Project"
                value={field.state.value}
                disabled={isSubmitting}
                aria-invalid={isInvalid}
                aria-describedby={isInvalid ? errorId : undefined}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              {isInvalid && (
                <FieldError id={errorId} errors={field.state.meta.errors} />
              )}
            </Field>
          );
        }}
      </form.Field>
      {submitError && <FieldError>{submitError}</FieldError>}
      <Button disabled={isSubmitting} type="submit">
        {isSubmitting ? "Creating…" : "Create Project"}
      </Button>
    </form>
  );
}
