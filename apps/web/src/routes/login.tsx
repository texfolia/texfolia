import { useForm } from "@tanstack/react-form-start";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "#/components/ui/field";
import { authClient } from "#/lib/auth-client";

export const Route = createFileRoute("/login")({
  component: RouteComponent,
});

function RouteComponent() {
  let [step, setStep] = useState<"email" | "token" | "otp">("email");

  const form = useForm({
    defaultValues: {
      step1: {
        email: "",
      },
      step2: {
        token: "",
      },
      step3: {
        otp: "",
      },
    },
    onSubmit: async ({ value }) => {
      await authClient.signIn.emailOtp({
        email: value.step1.email,
        otp: value.step3.otp,
      });
    },
  });

  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4">
      <FieldSet>
        <FieldLegend>Log in to Texfolia</FieldLegend>
        <FieldGroup>
          <Field>
            <Button
              onClick={() =>
                authClient.signIn.social({
                  provider: "github",
                })
              }
              variant="outline"
              className="rounded-full px-5 py-5"
            >
              Continue with GitHub
            </Button>
          </Field>
          <Field>
            <Button
              onClick={() =>
                authClient.signIn.social({
                  provider: "gitlab",
                })
              }
              variant="outline"
              className="rounded-full px-5 py-5"
            >
              Continue with GitLab
            </Button>
          </Field>
          <Field>
            <Button
              onClick={() =>
                authClient.signIn.social({
                  provider: "google",
                })
              }
              variant="outline"
              className="rounded-full px-5 py-5"
            >
              Continue with Google
            </Button>
          </Field>
          <FieldSeparator />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
          >
            <Field>
              <FieldLabel></FieldLabel>
            </Field>
          </form>
        </FieldGroup>
      </FieldSet>
    </div>
  );
}
