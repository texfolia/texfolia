"use client";

import { useForm, useStore } from "@tanstack/react-form-start";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { z } from "zod";

import { Button } from "#/components/ui/button";
import { Field, FieldError, FieldLabel } from "#/components/ui/field";
import { Form } from "#/components/ui/form";
import { Input } from "#/components/ui/input";
import { createProject } from "#/lib/projects.functions";

const schema = z.object({
  name: z.string().trim().min(1, { message: "Please enter a project name." }),
});

export function ProjectForm() {
  const navigate = useNavigate();
  const nameId = useId();
  const errorId = `${nameId}-error`;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: { name: "" },
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      setSubmitError(null);

      try {
        const projectId = await createProject({
          data: { name: value.name.trim() },
        });

        await navigate({
          to: "/projects/$projectId",
          params: { projectId },
        });
      } catch {
        setSubmitError("Unable to create your project. Please try again.");
      }
    },
  });
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <Form
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
      <Button loading={isSubmitting} type="submit">
        Create Project
      </Button>
    </Form>
  );
}
