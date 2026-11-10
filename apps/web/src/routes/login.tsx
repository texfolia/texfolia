import GitLabIcon from "@iconify-react/thesvg-color/gitlab";
import GoogleIcon from "@iconify-react/thesvg-color/google";
import MicrosoftIcon from "@iconify-react/thesvg-color/microsoft";
import GithubIcon from "@iconify-react/thesvg/github";
import { IconArrowLeft } from "@tabler/icons-react";
import { revalidateLogic, useForm } from "@tanstack/react-form-start";
import { createFileRoute } from "@tanstack/react-router";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { Turnstile, useTurnstile } from "react-turnstile";
import { z } from "zod";

import { Button } from "#/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "#/components/ui/input-otp";
import { authClient } from "#/lib/auth-client";

export const loginSearchSchema = z.object({
  redirectTo: z
    .string()
    // oxlint-disable-next-line no-control-regex -- Redirect targets must reject control characters.
    .regex(/^\/(?!\/)[^\u0000-\u0020\\]*$/)
    .catch("/projects")
    .optional(),
});

export const Route = createFileRoute("/login")({
  validateSearch: loginSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { redirectTo = "/projects" } = Route.useSearch();
  const turnstile = useTurnstile();

  const [step, setStep] = useState<"email" | "otp">("email");

  const form = useForm({
    defaultValues: {
      emailStep: {
        email: "",
        token: "",
      },
      otpStep: {
        otp: "",
      },
    },
    validationLogic: revalidateLogic({
      mode: "submit",
      modeAfterSubmission: "change",
    }),
    onSubmit: async ({ value }) => {
      if (step === "email") {
        const { data, error } = await authClient.emailOtp.sendVerificationOtp({
          email: value.emailStep.email,
          type: "sign-in",
          fetchOptions: {
            headers: {
              "x-captcha-response": value.emailStep.token,
            },
          },
        });

        if (error || !data) {
          turnstile.reset();
          return;
        }

        form.setFieldValue("emailStep.token", "");
        setStep("otp");
        return;
      }

      const { data, error } = await authClient.signIn.emailOtp({
        email: value.emailStep.email,
        otp: value.otpStep.otp,
      });

      if (error || !data) {
        return;
      }

      window.location.assign(redirectTo);
    },
  });

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
        className="w-full max-w-sm"
      >
        <AnimatePresence initial={false}>
          {step === "email" ? (
            <form.FormGroup name="emailStep">
              {() => (
                <FieldGroup>
                  <Field>
                    <Button
                      onClick={() =>
                        authClient.signIn.social({
                          provider: "github",
                          callbackURL: redirectTo,
                        })
                      }
                      size="lg"
                      type="button"
                    >
                      <GithubIcon />
                      Continue with GitHub
                    </Button>
                  </Field>
                  <Field>
                    <Button
                      type="button"
                      onClick={() =>
                        authClient.signIn.social({
                          provider: "gitlab",
                          callbackURL: redirectTo,
                        })
                      }
                      size="lg"
                      variant="outline"
                    >
                      <GitLabIcon />
                      Continue with GitLab
                    </Button>
                  </Field>
                  <Field>
                    <Button
                      onClick={() =>
                        authClient.signIn.social({
                          provider: "google",
                          callbackURL: redirectTo,
                        })
                      }
                      type="button"
                      size="lg"
                      variant="outline"
                    >
                      <GoogleIcon />
                      Continue with Google
                    </Button>
                  </Field>
                  <Field>
                    <Button
                      onClick={() =>
                        authClient.signIn.social({
                          provider: "microsoft",
                          callbackURL: redirectTo,
                        })
                      }
                      size="lg"
                      type="button"
                      variant="outline"
                    >
                      <MicrosoftIcon />
                      Continue with Microsoft
                    </Button>
                  </Field>
                  <FieldSeparator>or</FieldSeparator>
                  <form.Field
                    name="emailStep.email"
                    validators={{ onDynamic: z.email() }}
                  >
                    {(field) => {
                      const isInvalid = field.state.meta.errors.length > 0;
                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Email</FieldLabel>
                          <Input
                            aria-invalid={isInvalid}
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
                            <FieldError errors={field.state.meta.errors} />
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
                          disabled={!canSubmit || isSubmitting || !hasToken}
                          size="lg"
                          type="submit"
                        >
                          Continue with email
                        </Button>
                      </Field>
                    )}
                  </form.Subscribe>
                  <Field>
                    <Turnstile
                      onError={() => form.setFieldValue("emailStep.token", "")}
                      onExpire={() => form.setFieldValue("emailStep.token", "")}
                      onVerify={(token) =>
                        form.setFieldValue("emailStep.token", token)
                      }
                      sitekey={import.meta.env.VITE_TURNSTILE_SITE_KEY!}
                      theme="auto"
                      className="w-full"
                    />
                  </Field>
                </FieldGroup>
              )}
            </form.FormGroup>
          ) : (
            <FieldGroup>
              <Button
                onClick={() => setStep("email")}
                size="sm"
                variant="ghost"
              >
                <IconArrowLeft />
                Back
              </Button>
              <form.FormGroup name="otpStep">
                {() => (
                  <FieldGroup>
                    <form.Field
                      name="otpStep.otp"
                      validators={{ onDynamic: z.string().regex(/^\d{6}$/) }}
                    >
                      {(field) => {
                        const isInvalid = field.state.meta.errors.length > 0;
                        return (
                          <Field data-invalid={isInvalid}>
                            <FieldLabel htmlFor={field.name}>
                              One-time password
                            </FieldLabel>
                            <InputOTP
                              aria-invalid={isInvalid}
                              id={field.name}
                              maxLength={6}
                              name={field.name}
                              onBlur={field.handleBlur}
                              onChange={(value) => field.handleChange(value)}
                              onComplete={() => form.handleSubmit()}
                              pattern={REGEXP_ONLY_DIGITS}
                              value={field.state.value}
                            >
                              <InputOTPGroup>
                                <InputOTPSlot index={0} />
                                <InputOTPSlot index={1} />
                                <InputOTPSlot index={2} />
                              </InputOTPGroup>
                              <InputOTPSeparator />
                              <InputOTPGroup>
                                <InputOTPSlot index={3} />
                                <InputOTPSlot index={4} />
                                <InputOTPSlot index={5} />
                              </InputOTPGroup>
                            </InputOTP>
                            {isInvalid && (
                              <FieldError errors={field.state.meta.errors} />
                            )}
                          </Field>
                        );
                      }}
                    </form.Field>
                  </FieldGroup>
                )}
              </form.FormGroup>
            </FieldGroup>
          )}
        </AnimatePresence>
      </form>
    </div>
  );
}
