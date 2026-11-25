import { revalidateLogic, useForm } from "@tanstack/react-form-start";
import { useEffect, useRef, useState } from "react";
import type { BoundTurnstileObject } from "react-turnstile";

import { authClient } from "#/lib/auth/auth-client";

export const socialProviders = [
  { id: "github", label: "GitHub" },
  { id: "gitlab", label: "GitLab" },
  { id: "google", label: "Google" },
  { id: "microsoft", label: "Microsoft" },
] satisfies {
  id: "github" | "gitlab" | "google" | "microsoft";
  label: string;
}[];

export type SocialProvider = (typeof socialProviders)[number]["id"];
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

/** Signing in with a code sent by email, or with another account. */
export function useLogin({
  redirectTo,
  failed,
}: {
  redirectTo: string;
  /** A provider sent the user back without signing in. */
  failed: boolean;
}) {
  const turnstile = useRef<BoundTurnstileObject | null>(null);
  const requestInFlight = useRef(false);

  const [step, setStep] = useState<"email" | "otp">("email");
  const [pending, setPending] = useState<
    "send" | "verify" | SocialProvider | null
  >(null);
  const [error, setError] = useState<string | null>(
    failed
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

  const waiting = sendWait > 0 || retryWait > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting]);

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

  function changeEmail() {
    setStep("email");
    setError(null);
    setStatus("");
    form.resetField("otpStep.otp");
    requestAnimationFrame(() =>
      document.getElementById("emailStep.email")?.focus(),
    );
  }

  /** The security check's token, or why there is none. */
  function setCaptcha(result: { token: string } | { error: string }) {
    const token = "token" in result ? result.token : "";
    form.setFieldValue("emailStep.token", token);
    setCaptchaError("error" in result ? result.error : null);
  }

  function retryCaptcha() {
    if (turnstile.current) turnstile.current.reset();
    else window.location.reload();
  }

  return {
    form,
    step,
    pending,
    error,
    status,
    sendWait,
    retryWait,
    sendCode,
    signInWith,
    changeEmail,
    captcha: {
      error: captchaError,
      load(widget: BoundTurnstileObject) {
        turnstile.current = widget;
      },
      set: setCaptcha,
      retry: retryCaptcha,
    },
  };
}

export type Login = ReturnType<typeof useLogin>;
