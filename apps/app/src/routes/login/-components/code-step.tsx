import { IconArrowLeft } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@texfolia/ui/field";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@texfolia/ui/input-otp";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { z } from "zod";

import type { Login } from "./use-login";

export function CodeStep({ login }: { login: Login }) {
  const { form, pending, retryWait, changeEmail } = login;
  return (
    <FieldGroup className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
      <Button
        type="button"
        disabled={pending !== null}
        onClick={changeEmail}
        size="sm"
        variant="ghost"
      >
        <IconArrowLeft />
        Change email
      </Button>
      <form.FormGroup name="otpStep">
        {() => (
          <FieldGroup>
            <form.Field
              name="otpStep.otp"
              validators={{
                onDynamic: z
                  .string()
                  .regex(
                    /^\d{6}$/,
                    "Enter the six-digit code from your email.",
                  ),
              }}
            >
              {(field) => {
                const isInvalid = field.state.meta.errors.length > 0;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel className="justify-center" htmlFor={field.name}>
                      One-time password
                    </FieldLabel>
                    <InputOTP
                      containerClassName="justify-center"
                      aria-invalid={isInvalid}
                      aria-describedby={
                        isInvalid
                          ? "otp-help otp-error login-error"
                          : "otp-help login-error"
                      }
                      disabled={pending !== null}
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      pushPasswordManagerStrategy="none"
                      id={field.name}
                      maxLength={6}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(value) => field.handleChange(value)}
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
                      <FieldError
                        id="otp-error"
                        errors={field.state.meta.errors}
                      />
                    )}
                  </Field>
                );
              }}
            </form.Field>
            <Button
              className="h-11 motion-reduce:transition-none"
              size="lg"
              type="submit"
              disabled={pending !== null || retryWait > 0}
              aria-busy={pending === "verify"}
            >
              {pending === "verify" ? "Verifying…" : "Verify and sign in"}
            </Button>
          </FieldGroup>
        )}
      </form.FormGroup>
    </FieldGroup>
  );
}
