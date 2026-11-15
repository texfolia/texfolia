import {
  IconArrowLeft,
  IconBrandGithub,
  IconBrandGitlab,
  IconBrandGoogle,
  IconBrandWindows,
} from "@tabler/icons-react";
import { revalidateLogic, useForm } from "@tanstack/react-form-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useEffect, useRef, useState } from "react";
import { Turnstile, type BoundTurnstileObject } from "react-turnstile";
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
import { AUTH_EMAIL_CAPTCHA_ACTION } from "#/lib/auth-captcha";
import { authClient } from "#/lib/auth-client";

export const loginSearchSchema = z.object({
  redirectTo: z
    .string()
    // oxlint-disable-next-line no-control-regex -- Redirect targets must reject control characters.
    .regex(/^\/(?!\/)[^\u0000-\u0020\\]*$/)
    .catch("/projects")
    .optional(),
  error: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/login")({
  validateSearch: loginSearchSchema,
  head: () => ({ meta: [{ title: "Sign in | Texfolia" }] }),
  component: RouteComponent,
});

const socialProviders = [
  { id: "github", label: "GitHub", Icon: IconBrandGithub },
  { id: "gitlab", label: "GitLab", Icon: IconBrandGitlab },
  { id: "google", label: "Google", Icon: IconBrandGoogle },
  { id: "microsoft", label: "Microsoft", Icon: IconBrandWindows },
] satisfies {
  id: "github" | "gitlab" | "google" | "microsoft";
  label: string;
  Icon: typeof IconBrandGithub;
}[];

type SocialProvider = (typeof socialProviders)[number]["id"];
type LoginError = NonNullable<
  Awaited<ReturnType<typeof authClient.signIn.emailOtp>>["error"]
>;

function loginErrorMessage(
  error: LoginError,
  action: "send" | "verify" | "social",
) {
  if (error.status === 429) {
    return "Too many attempts. Wait for the countdown, then try again.";
  }
  switch (error.code) {
    case "INVALID_OTP":
      return "That code is incorrect or no longer valid. Check your latest email, or request a new code.";
    case "OTP_EXPIRED":
      return "That code has expired. Request a new code to sign in.";
    case "TOO_MANY_ATTEMPTS":
      return "That code has been tried too many times. Request a new code to continue.";
    case "VERIFICATION_FAILED":
    case "MISSING_RESPONSE":
      return "The security check could not be verified. Complete it again, then retry.";
  }
  if (action === "social") {
    return "This sign-in provider is unavailable. Try again or sign in with email.";
  }
  return action === "send"
    ? "We couldn't send a code right now. Please try again shortly."
    : "We couldn't verify your code right now. Please try again shortly.";
}

function RouteComponent() {
  const { redirectTo = "/projects", error: callbackError } = Route.useSearch();
  const turnstile = useRef<BoundTurnstileObject | null>(null);
  const requestInFlight = useRef(false);

  const [step, setStep] = useState<"email" | "otp">("email");
  const [pending, setPending] = useState<
    "send" | "verify" | SocialProvider | null
  >(null);
  const [error, setError] = useState<string | null>(
    callbackError
      ? "Sign-in could not be completed. Try again or sign in with email."
      : null,
  );
  const [status, setStatus] = useState("");
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [sendAfter, setSendAfter] = useState(0);
  const [retryAfter, setRetryAfter] = useState(0);
  const [now, setNow] = useState(Date.now);
  const sendWait = Math.max(
    0,
    Math.ceil((Math.max(sendAfter, retryAfter) - now) / 1000),
  );
  const retryWait = Math.max(0, Math.ceil((retryAfter - now) / 1000));

  useEffect(() => {
    if (!sendWait && !retryWait) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sendWait > 0, retryWait > 0]);

  useEffect(() => {
    if (step === "otp" && pending === null)
      document.getElementById("otpStep.otp")?.focus();
  }, [step, pending]);

  function handleResponse({ response }: { response: Response }) {
    if (response.status !== 429) return;
    const header =
      response.headers.get("Retry-After") ??
      response.headers.get("X-Retry-After");
    const seconds = header === null ? NaN : Number(header);
    const deadline = Number.isFinite(seconds)
      ? Date.now() + Math.max(1, seconds) * 1000
      : Date.parse(header ?? "");
    setRetryAfter(
      Number.isFinite(deadline)
        ? Math.max(Date.now() + 1000, deadline)
        : Date.now() + 60_000,
    );
    setNow(Date.now());
  }

  async function runRequest(
    action: NonNullable<typeof pending>,
    request: () => Promise<void>,
  ) {
    if (requestInFlight.current || Date.now() < retryAfter) return;
    requestInFlight.current = true;
    setPending(action);
    setError(null);
    setStatus("");
    try {
      await request();
    } catch {
      setError(
        "We couldn't connect to sign-in. Check your connection and try again.",
      );
    } finally {
      requestInFlight.current = false;
      setPending(null);
    }
  }

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
        await sendCode();
        return;
      }

      await runRequest("verify", async () => {
        const { data, error } = await authClient.signIn.emailOtp({
          email: value.emailStep.email,
          otp: value.otpStep.otp,
          fetchOptions: { onResponse: handleResponse, timeout: 15_000 },
        });
        if (error || !data) {
          setError(
            error
              ? loginErrorMessage(error, "verify")
              : "We couldn't verify your code. Please try again.",
          );
          return;
        }
        window.location.assign(redirectTo);
      });
    },
  });

  async function sendCode() {
    const { email, token } = form.state.values.emailStep;
    if (!token || Date.now() < sendAfter) return;
    await runRequest("send", async () => {
      form.setFieldValue("emailStep.token", "");
      try {
        const { data, error } = await authClient.emailOtp.sendVerificationOtp({
          email,
          type: "sign-in",
          fetchOptions: {
            headers: { "x-captcha-response": token },
            onResponse: handleResponse,
            timeout: 15_000,
          },
        });
        if (error || !data) {
          setError(
            error
              ? loginErrorMessage(error, "send")
              : "We couldn't send a code. Please try again.",
          );
          return;
        }
        setSendAfter(Date.now() + 60_000);
        setNow(Date.now());
        form.resetField("otpStep.otp");
        setStatus(
          step === "otp"
            ? "A new code has been sent. Use the code in your latest email."
            : "Code sent. Check your email.",
        );
        setStep("otp");
      } finally {
        form.setFieldValue("emailStep.token", "");
        turnstile.current?.reset();
      }
    });
  }

  async function signInWith(provider: SocialProvider) {
    await runRequest(provider, async () => {
      const { data, error } = await authClient.signIn.social({
        provider,
        callbackURL: redirectTo,
        errorCallbackURL: `/login?redirectTo=${encodeURIComponent(redirectTo)}`,
        fetchOptions: { onResponse: handleResponse, timeout: 15_000 },
      });
      if (error || !data) {
        setError(
          error
            ? loginErrorMessage(error, "social")
            : "This sign-in provider is unavailable. Try again or sign in with email.",
        );
      }
    });
  }

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <aside className="bg-muted/50 hidden flex-col justify-between border-r p-12 lg:flex">
        <Link to="/" className="font-serif text-3xl tracking-tight">
          Texfolia.
        </Link>
        <div className="py-16">
          <p className="max-w-lg font-serif text-6xl leading-tight tracking-tight">
            Your next chapter
            <br />
            starts <span className="italic">here.</span>
          </p>
          <p className="text-muted-foreground mt-8 max-w-sm text-lg leading-relaxed">
            A quiet place to write, a shared space to think. Pick up where you
            left off.
          </p>
        </div>
        <p className="text-muted-foreground text-sm">
          LaTeX, with room for your ideas.
        </p>
      </aside>
      <main
        id="main-content"
        className="flex min-h-svh flex-col items-center justify-center px-6 py-10 sm:px-12"
      >
        <Link to="/" className="mb-10 font-serif text-3xl lg:hidden">
          Texfolia.
        </Link>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
          className="w-full max-w-sm space-y-5"
          aria-label="Sign in"
        >
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">
              {step === "email" ? "Sign in to Texfolia" : "Check your email"}
            </h1>
            {step === "otp" && (
              <p
                id="otp-help"
                className="text-muted-foreground text-sm break-words"
              >
                Enter the six-digit code sent to{" "}
                {form.state.values.emailStep.email}. Codes expire after 5
                minutes.
              </p>
            )}
          </div>
          <div
            id="login-error"
            role="alert"
            aria-atomic="true"
            className="text-destructive text-sm empty:sr-only"
          >
            {error}
          </div>
          <p
            role="status"
            aria-atomic="true"
            className="text-muted-foreground text-sm empty:sr-only"
          >
            {status}
          </p>
          {retryWait > 0 && (
            <p className="text-muted-foreground text-sm">
              Try again in {retryWait}s.
            </p>
          )}
          {step === "email" ? (
            <form.FormGroup name="emailStep">
              {() => (
                <FieldGroup className="gap-3">
                  {socialProviders.map(({ id, label, Icon }) => (
                    <Field key={id}>
                      <Button
                        onClick={() => signInWith(id)}
                        disabled={pending !== null || retryWait > 0}
                        size="lg"
                        type="button"
                        variant="outline"
                        aria-busy={pending === id}
                      >
                        <Icon />
                        {pending === id
                          ? `Connecting to ${label}…`
                          : `Continue with ${label}`}
                      </Button>
                    </Field>
                  ))}
                  <FieldSeparator>or</FieldSeparator>
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
                          <FieldLabel htmlFor={field.name}>Email</FieldLabel>
                          <Input
                            aria-invalid={isInvalid}
                            aria-describedby={
                              isInvalid ? "email-error" : undefined
                            }
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
          ) : (
            <FieldGroup>
              <Button
                type="button"
                disabled={pending !== null}
                onClick={() => {
                  setStep("email");
                  setError(null);
                  setStatus("");
                  form.resetField("otpStep.otp");
                  requestAnimationFrame(() =>
                    document.getElementById("emailStep.email")?.focus(),
                  );
                }}
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
                            <FieldLabel htmlFor={field.name}>
                              One-time password
                            </FieldLabel>
                            <InputOTP
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
                      size="lg"
                      type="submit"
                      disabled={pending !== null || retryWait > 0}
                      aria-busy={pending === "verify"}
                    >
                      {pending === "verify"
                        ? "Verifying…"
                        : "Verify and sign in"}
                    </Button>
                  </FieldGroup>
                )}
              </form.FormGroup>
            </FieldGroup>
          )}
          <div className="space-y-3">
            {step === "otp" && (
              <form.Subscribe
                selector={(state) => !!state.values.emailStep.token}
              >
                {(hasToken) => (
                  <Button
                    className="w-full"
                    variant="outline"
                    size="lg"
                    type="button"
                    onClick={sendCode}
                    disabled={pending !== null || sendWait > 0 || !hasToken}
                    aria-busy={pending === "send"}
                  >
                    {pending === "send"
                      ? "Sending code…"
                      : sendWait > 0
                        ? `Resend code in ${sendWait}s`
                        : "Resend code"}
                  </Button>
                )}
              </form.Subscribe>
            )}
            <p id="captcha-help" className="text-muted-foreground text-sm">
              Complete the security check to{" "}
              {step === "email" ? "receive" : "resend"} a code.
            </p>
            <Turnstile
              action={AUTH_EMAIL_CAPTCHA_ACTION}
              onLoad={(_id, widget) => {
                turnstile.current = widget;
              }}
              onError={() => {
                form.setFieldValue("emailStep.token", "");
                setCaptchaError(
                  "The security check is unavailable. Retry it or use another sign-in method.",
                );
              }}
              onExpire={() => {
                form.setFieldValue("emailStep.token", "");
                setCaptchaError(
                  "The security check expired. Complete it again before requesting a code.",
                );
              }}
              onTimeout={() => {
                form.setFieldValue("emailStep.token", "");
                setCaptchaError(
                  "The security check timed out. Please retry it.",
                );
              }}
              onUnsupported={() => {
                form.setFieldValue("emailStep.token", "");
                setCaptchaError(
                  "The security check does not support this browser. Try another browser or sign-in method.",
                );
              }}
              onVerify={(token) => {
                form.setFieldValue("emailStep.token", token);
                setCaptchaError(null);
              }}
              sitekey={import.meta.env.VITE_TURNSTILE_SITE_KEY ?? ""}
              theme="auto"
              size="flexible"
              className="w-full"
            />
            <div
              role="alert"
              aria-atomic="true"
              className="text-destructive text-sm empty:sr-only"
            >
              {captchaError}
            </div>
            {captchaError && (
              <Button
                variant="outline"
                type="button"
                disabled={pending !== null}
                onClick={() => {
                  if (turnstile.current) turnstile.current.reset();
                  else window.location.reload();
                }}
              >
                Retry security check
              </Button>
            )}
          </div>
        </form>
        <nav
          aria-label="Legal information"
          className="text-muted-foreground mt-10 flex gap-6 text-xs [&_a]:underline [&_a]:underline-offset-4"
        >
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </nav>
      </main>
    </div>
  );
}
