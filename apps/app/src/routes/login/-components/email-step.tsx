import { Button } from "@texfolia/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import { z } from "zod";

import { type Login, socialProviders } from "./use-login";

export function EmailStep({ login }: { login: Login }) {
  const { form, pending, sendWait, retryWait, signInWith } = login;
  return (
    <form.FormGroup name="emailStep">
      {() => (
        <FieldGroup className="gap-2">
          {socialProviders.map(({ id, label }) => (
            <Field key={id}>
              <Button
                onClick={() => void signInWith(id)}
                disabled={pending !== null || retryWait > 0}
                size="lg"
                type="button"
                variant="outline"
                className="relative h-11 px-10 motion-reduce:transition-none"
                aria-busy={pending === id}
              >
                <img
                  src={`/auth/${id}.${id === "google" ? "png" : "svg"}`}
                  width={20}
                  height={20}
                  alt=""
                  className={`absolute left-3 size-5 object-contain ${id === "github" ? "dark:invert" : ""}`}
                />
                {pending === id
                  ? `Connecting to ${label}…`
                  : `Continue with ${label}`}
              </Button>
            </Field>
          ))}
          <FieldSeparator className="my-4">or</FieldSeparator>
          <form.Field
            name="emailStep.email"
            validators={{
              onDynamic: z.email("Enter a valid email address."),
            }}
          >
            {(field) => {
              const isInvalid = field.state.meta.errors.length > 0;
              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel className="justify-center" htmlFor={field.name}>
                    Email
                  </FieldLabel>
                  <Input
                    className="h-11 text-center"
                    aria-invalid={isInvalid}
                    aria-describedby={isInvalid ? "email-error" : undefined}
                    disabled={pending !== null}
                    autoCapitalize="off"
                    autoComplete="email"
                    id={field.name}
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="you@example.com"
                    value={field.state.value}
                  />
                  {isInvalid && (
                    <FieldError
                      id="email-error"
                      errors={field.state.meta.errors}
                    />
                  )}
                </Field>
              );
            }}
          </form.Field>
          <form.Subscribe
            selector={(state) => ({
              canSubmit: state.canSubmit,
              isSubmitting: state.isSubmitting,
              hasToken: !!state.values.emailStep.token,
            })}
          >
            {({ canSubmit, isSubmitting, hasToken }) => (
              <Field>
                <Button
                  className="h-11 motion-reduce:transition-none"
                  disabled={
                    !canSubmit ||
                    isSubmitting ||
                    !hasToken ||
                    pending !== null ||
                    sendWait > 0
                  }
                  aria-busy={pending === "send"}
                  size="lg"
                  type="submit"
                >
                  {pending === "send"
                    ? "Sending code…"
                    : sendWait > 0
                      ? `Send another code in ${sendWait}s`
                      : "Continue with email"}
                </Button>
              </Field>
            )}
          </form.Subscribe>
        </FieldGroup>
      )}
    </form.FormGroup>
  );
}
