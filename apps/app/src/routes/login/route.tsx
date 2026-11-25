import { createFileRoute, Link } from "@tanstack/react-router";

import { webPath } from "#/lib/origins";

import { CodeStep } from "./-components/code-step";
import { EmailStep } from "./-components/email-step";
import { ResendCode, SecurityCheck } from "./-components/security-check";
import { useLogin } from "./-components/use-login";

// oxlint-disable-next-line no-control-regex -- Redirect targets must reject control characters.
const redirectTarget = /^\/(?!\/)[^\u0000-\u0020\\]*$/;

// Always return the keys: the router keeps raw search values a validator omits.
export function loginSearch({ redirectTo, error }: Record<string, unknown>): {
  redirectTo?: string;
  error?: string;
} {
  return {
    redirectTo:
      redirectTo === undefined ||
      (typeof redirectTo === "string" && redirectTarget.test(redirectTo))
        ? redirectTo
        : "/projects",
    error: typeof error === "string" ? error : undefined,
  };
}

export const Route = createFileRoute("/login")({
  validateSearch: loginSearch,
  head: () => ({ meta: [{ title: "Sign in | Texfolia" }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { redirectTo = "/projects", error: callbackError } = Route.useSearch();
  const login = useLogin({ redirectTo, failed: !!callbackError });
  const { form, step, error, status, retryWait } = login;
  return (
    <div className="bg-background text-foreground min-h-svh">
      <a
        href="#sign-in-form"
        className="bg-background sr-only z-50 p-3 focus:not-sr-only focus:absolute focus:top-0 focus:left-0"
      >
        Skip to sign-in form
      </a>
      <main
        id="main-content"
        className="flex min-h-svh flex-col items-center justify-center px-2 py-12 sm:px-6"
      >
        <Link
          to="/"
          className="font-heading mb-8 text-xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          Texfolia<span className="text-muted-foreground">.</span>
        </Link>
        <form
          id="sign-in-form"
          tabIndex={-1}
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
          className="w-full max-w-xs space-y-5 text-center"
          aria-label="Sign in"
        >
          <div
            key={step}
            className="motion-safe:animate-in motion-safe:fade-in space-y-3 text-center motion-safe:duration-200"
          >
            <h1 className="font-heading text-xl font-medium tracking-tight">
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
            <EmailStep login={login} />
          ) : (
            <CodeStep login={login} />
          )}
          <div className="space-y-3">
            {step === "otp" && <ResendCode login={login} />}
            <SecurityCheck login={login} />
          </div>
        </form>
        <nav
          aria-label="Legal information"
          className="text-muted-foreground [&_a]:hover:text-foreground mt-8 max-w-xs text-center text-xs leading-relaxed [&_a]:underline [&_a]:underline-offset-4 [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-4"
        >
          <p>
            Read our <a href={webPath("/privacy")}>Privacy Policy</a> and{" "}
            <a href={webPath("/terms")}>Terms of Service</a>.
          </p>
        </nav>
      </main>
    </div>
  );
}
