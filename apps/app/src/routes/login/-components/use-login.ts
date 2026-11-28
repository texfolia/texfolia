import { revalidateLogic, useForm } from "@tanstack/react-form-start";
import { useEffect, useRef, useState } from "react";
import type { BoundTurnstileObject } from "react-turnstile";

import { authClient, TWO_FACTOR_REQUIRED_EVENT } from "#/lib/auth/auth-client";

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
type LoginError = {
  code?: string;
  message?: string;
  status?: number;
};

function loginErrorMessage(
  error: LoginError,
  action: "send" | "verify" | "social" | "passkey" | "twoFactor",
) {
  if (error.code === "ACCOUNT_TEMPORARILY_LOCKED") {
    return "Too many failed attempts. Your account is temporarily locked. Try again later.";
  }
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
    case "INVALID_CODE":
      return "That authenticator code is incorrect. Check your app and try again.";
    case "INVALID_BACKUP_CODE":
      return "That backup code is invalid or has already been used.";
    case "INVALID_TWO_FACTOR_COOKIE":
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      return "Your verification session expired. Start sign-in again.";
    case "AUTH_CANCELLED":
    case "ERROR_CEREMONY_ABORTED":
      return "Passkey sign-in was cancelled.";
  }
  if (action === "social") {
    return "This sign-in provider is unavailable. Try again or sign in with email.";
  }
  if (action === "passkey") {
    return "We couldn't verify your passkey. Try again or use another sign-in method.";
  }
  if (action === "twoFactor") {
    return "We couldn't verify your two-factor code right now. Please try again.";
  }
  return action === "send"
    ? "We couldn't send a code right now. Please try again shortly."
    : "We couldn't verify your code right now. Please try again shortly.";
}

/** Signing in with a passkey, an emailed code, or another account. */
export function useLogin({
  redirectTo,
  failed,
  twoFactor = false,
}: {
  redirectTo: string;
  /** A provider sent the user back without signing in. */
  failed: boolean;
  /** An OAuth callback redirected here to finish a pending 2FA challenge. */
  twoFactor?: boolean;
}) {
  const turnstile = useRef<BoundTurnstileObject | null>(null);
  const requestInFlight = useRef(false);

  const [step, setStep] = useState<"email" | "otp" | "twoFactor">(
    twoFactor ? "twoFactor" : "email",
  );
  const [twoFactorMode, setTwoFactorMode] = useState<"totp" | "backup">("totp");
  const [trustDevice, setTrustDevice] = useState(false);
  const [pending, setPending] = useState<
    "send" | "verify" | "passkey" | "twoFactor" | SocialProvider | null
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
    const onTwoFactorRequired = () => {
      setError(null);
      setStatus("");
      setTwoFactorMode("totp");
      setStep("twoFactor");
    };
    window.addEventListener(TWO_FACTOR_REQUIRED_EVENT, onTwoFactorRequired);
    return () =>
      window.removeEventListener(
        TWO_FACTOR_REQUIRED_EVENT,
        onTwoFactorRequired,
      );
  }, []);

  // Conditional UI: let browsers offer saved passkeys in the email field autofill.
  useEffect(() => {
    if (step !== "email") return;
    if (
      typeof window === "undefined" ||
      typeof PublicKeyCredential === "undefined" ||
      typeof PublicKeyCredential.isConditionalMediationAvailable !== "function"
    ) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const available =
          await PublicKeyCredential.isConditionalMediationAvailable();
        if (!available || cancelled) return;
        const result = await authClient.signIn.passkey({ autoFill: true });
        if (!cancelled && result?.data && !result.error) {
          window.location.assign(redirectTo);
        }
      } catch {
        // Conditional mediation is optional; ignore aborts or browser denials.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, redirectTo]);

  useEffect(() => {
    if (step === "otp" && pending === null) {
      document.getElementById("otpStep.otp")?.focus();
    } else if (step === "twoFactor" && pending === null) {
      const targetId =
        twoFactorMode === "totp"
          ? "twoFactorStep.totp"
          : "twoFactorStep.backupCode";
      document.getElementById(targetId)?.focus();
    }
  }, [step, twoFactorMode, pending]);

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
      twoFactorStep: {
        totp: "",
        backupCode: "",
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

      if (step === "twoFactor") {
        await runRequest("twoFactor", async () => {
          const result =
            twoFactorMode === "totp"
              ? await authClient.twoFactor.verifyTotp({
                  code: value.twoFactorStep.totp,
                  trustDevice,
                  fetchOptions: { onResponse: handleResponse, timeout: 15_000 },
                })
              : await authClient.twoFactor.verifyBackupCode({
                  code: value.twoFactorStep.backupCode.trim(),
                  trustDevice,
                  fetchOptions: { onResponse: handleResponse, timeout: 15_000 },
                });
          if (result.error || !result.data) {
            setError(
              result.error
                ? loginErrorMessage(result.error, "twoFactor")
                : "We couldn't verify your two-factor code. Please try again.",
            );
            return;
          }
          window.location.assign(redirectTo);
        });
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
        if ("twoFactorRedirect" in data && data.twoFactorRedirect) {
          form.resetField("twoFactorStep.totp");
          form.resetField("twoFactorStep.backupCode");
          setTwoFactorMode("totp");
          setStep("twoFactor");
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

  async function signInWithPasskey() {
    if (
      typeof PublicKeyCredential === "undefined" ||
      typeof navigator.credentials?.get !== "function"
    ) {
      setError("Passkeys are not supported in this browser.");
      return;
    }
    await runRequest("passkey", async () => {
      const result = await authClient.signIn.passkey({
        fetchOptions: { onResponse: handleResponse, timeout: 30_000 },
      });
      if (result?.error || !result?.data) {
        setError(
          result?.error
            ? loginErrorMessage(result.error, "passkey")
            : "We couldn't verify your passkey. Try again or use another sign-in method.",
        );
        return;
      }
      window.location.assign(redirectTo);
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

  function cancelTwoFactor() {
    setStep("email");
    setError(null);
    setStatus("");
    setTwoFactorMode("totp");
    form.resetField("twoFactorStep.totp");
    form.resetField("twoFactorStep.backupCode");
    requestAnimationFrame(() =>
      document.getElementById("emailStep.email")?.focus(),
    );
  }

  function switchTwoFactorMode(mode: "totp" | "backup") {
    setError(null);
    setTwoFactorMode(mode);
    form.resetField("twoFactorStep.totp");
    form.resetField("twoFactorStep.backupCode");
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
    twoFactorMode,
    trustDevice,
    setTrustDevice,
    switchTwoFactorMode,
    cancelTwoFactor,
    pending,
    error,
    status,
    sendWait,
    retryWait,
    sendCode,
    signInWith,
    signInWithPasskey,
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
