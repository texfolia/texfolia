import { Button } from "@texfolia/ui/button";
import { Turnstile } from "react-turnstile";

import { AUTH_EMAIL_CAPTCHA_ACTION } from "#/lib/auth/captcha";

import type { Login } from "./use-login";

export function SecurityCheck({ login }: { login: Login }) {
  const { captcha, pending } = login;
  return (
    <>
      <Turnstile
        action={AUTH_EMAIL_CAPTCHA_ACTION}
        onLoad={(_id, widget) => captcha.load(widget)}
        onError={() =>
          captcha.set({
            error:
              "The security check is unavailable. Retry it or use another sign-in method.",
          })
        }
        onExpire={() =>
          captcha.set({
            error:
              "The security check expired. Complete it again before requesting a code.",
          })
        }
        onTimeout={() =>
          captcha.set({
            error: "The security check timed out. Please retry it.",
          })
        }
        onUnsupported={() =>
          captcha.set({
            error:
              "The security check does not support this browser. Try another browser or sign-in method.",
          })
        }
        onVerify={(token) => captcha.set({ token })}
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
        {captcha.error}
      </div>
      {captcha.error && (
        <Button
          variant="outline"
          type="button"
          disabled={pending !== null}
          onClick={captcha.retry}
        >
          Retry security check
        </Button>
      )}
    </>
  );
}

export function ResendCode({ login }: { login: Login }) {
  const { form, pending, sendWait, sendCode } = login;
  return (
    <form.Subscribe selector={(state) => !!state.values.emailStep.token}>
      {(hasToken) => (
        <Button
          className="h-11 w-full motion-reduce:transition-none"
          variant="outline"
          size="lg"
          type="button"
          onClick={() => void sendCode()}
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
  );
}
