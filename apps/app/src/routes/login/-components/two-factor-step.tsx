import { IconArrowLeft } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@texfolia/ui/input-otp";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { z } from "zod";

import type { Login } from "./use-login";

export function TwoFactorStep({ login }: { login: Login }) {
  const {
    form,
    twoFactorMode,
    trustDevice,
    setTrustDevice,
    switchTwoFactorMode,
    cancelTwoFactor,
    pending,
    retryWait,
  } = login;

  return (
    <FieldGroup className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
      <Button
        type="button"
        disabled={pending !== null}
        onClick={cancelTwoFactor}
        size="sm"
        variant="ghost"
      >
        <IconArrowLeft />
        Back to sign in
      </Button>
      <form.FormGroup name="twoFactorStep">
        {() => (
          <FieldGroup>
            {twoFactorMode === "totp" ? (
              <form.Field
                name="twoFactorStep.totp"
                validators={{
                  onDynamic: z
                    .string()
                    .regex(
                      /^\d{6}$/,
                      "Enter the six-digit code from your authenticator app.",
                    ),
                }}
              >
                {(field) => {
                  const isInvalid = field.state.meta.errors.length > 0;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel
                        className="justify-center"
                        htmlFor={field.name}
                      >
                        Authenticator code
                      </FieldLabel>
                      <InputOTP
                        containerClassName="justify-center"
                        aria-invalid={isInvalid}
                        aria-describedby={
                          isInvalid
                            ? "two-factor-help two-factor-error login-error"
                            : "two-factor-help login-error"
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
                          id="two-factor-error"
                          errors={field.state.meta.errors}
                        />
                      )}
                    </Field>
                  );
                }}
              </form.Field>
            ) : (
              <form.Field
                name="twoFactorStep.backupCode"
                validators={{
                  onDynamic: z
                    .string()
                    .trim()
                    .min(1, "Enter one of your recovery backup codes."),
                }}
              >
                {(field) => {
                  const isInvalid = field.state.meta.errors.length > 0;
                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel
                        className="justify-center"
                        htmlFor={field.name}
                      >
                        Backup code
                      </FieldLabel>
                      <Input
                        className="h-11 text-center font-mono"
                        aria-invalid={isInvalid}
                        aria-describedby={
                          isInvalid
                            ? "two-factor-help two-factor-error login-error"
                            : "two-factor-help login-error"
                        }
                        disabled={pending !== null}
                        autoCapitalize="off"
                        autoComplete="off"
                        spellCheck={false}
                        id={field.name}
                        name={field.name}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder="xxxxx-xxxxx"
                        value={field.state.value}
                      />
                      {isInvalid && (
                        <FieldError
                          id="two-factor-error"
                          errors={field.state.meta.errors}
                        />
                      )}
                    </Field>
                  );
                }}
              </form.Field>
            )}
            <label className="text-muted-foreground flex cursor-pointer items-center justify-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={trustDevice}
                disabled={pending !== null}
                onChange={(e) => setTrustDevice(e.target.checked)}
                className="accent-primary size-4 rounded border"
              />
              <span>Trust this device for 30 days</span>
            </label>
            <Button
              className="h-11 motion-reduce:transition-none"
              size="lg"
              type="submit"
              disabled={pending !== null || retryWait > 0}
              aria-busy={pending === "twoFactor"}
            >
              {pending === "twoFactor" ? "Verifying…" : "Verify and sign in"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending !== null}
              onClick={() =>
                switchTwoFactorMode(
                  twoFactorMode === "totp" ? "backup" : "totp",
                )
              }
            >
              {twoFactorMode === "totp"
                ? "Use a backup code instead"
                : "Use an authenticator app instead"}
            </Button>
          </FieldGroup>
        )}
      </form.FormGroup>
    </FieldGroup>
  );
}
