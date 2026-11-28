import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Turnstile, type BoundTurnstileObject } from "react-turnstile";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "#/components/ui/alert-dialog";
import { Button, buttonVariants } from "#/components/ui/button";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from "#/components/ui/item";
import { authClient } from "#/lib/auth/auth-client";
import { AUTH_EMAIL_CAPTCHA_ACTION } from "#/lib/auth/captcha";

import { PasskeysSection } from "./-components/passkeys-section";
import { TwoFactorSection } from "./-components/two-factor-section";

type ActiveSession = {
  id: string;
  token: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatSessionDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

function summarizeUserAgent(userAgent: string | null | undefined) {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(userAgent)
      ? "macOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad|iOS/.test(userAgent)
          ? "iOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}

// Why the emailed deletion link was refused, as `organization-policy.ts` names it.
const deletionBlocks = ["blocked", "subscribed", "unchecked"] as const;

export const Route = createFileRoute("/settings/account")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { deletion?: (typeof deletionBlocks)[number] } => ({
    deletion: deletionBlocks.find((reason) => reason === search.deletion),
  }),
  component: AccountPage,
});

function AccountPage() {
  const { user } = Route.useRouteContext();
  const { deletion } = Route.useSearch();
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [image, setImage] = useState(user.image ?? "");
  const [email, setEmail] = useState(user.email);
  const [emailSentTo, setEmailSentTo] = useState("");
  const [otp, setOtp] = useState("");
  const turnstile = useRef<BoundTurnstileObject | null>(null);
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaError, setCaptchaError] = useState("");
  const emailChanged = email.trim() !== user.email;
  function captchaFailed(reason: string) {
    setCaptchaToken("");
    setCaptchaError(reason);
  }
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState("");

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      const [current, list] = await Promise.all([
        authClient.getSession(),
        authClient.listSessions(),
      ]);
      if (list.error)
        throw new Error(
          list.error.message ?? "Could not load active sessions.",
        );
      setCurrentSessionId(current.data?.session.id ?? null);
      setSessions((list.data ?? []) as ActiveSession[]);
    } catch (cause) {
      setSessionsError(
        cause instanceof Error
          ? cause.message
          : "Could not load active sessions.",
      );
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  async function run(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Your account could not be updated. Try again.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const otherSessionCount = sessions.filter(
    (item) => item.id !== currentSessionId,
  ).length;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Account</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Manage your profile, sign-in email, two-factor authentication,
          passkeys, active sessions, and account data.
        </p>
      </div>
      {deletion === "blocked" && (
        <p role="alert" className="text-destructive text-sm">
          Your account could not be deleted because you are the only owner of an
          organization. Transfer ownership or delete the organization in{" "}
          <Link to="/settings/organizations" className="underline">
            Organizations settings
          </Link>{" "}
          first.
        </p>
      )}
      {deletion === "subscribed" && (
        <p role="alert" className="text-destructive text-sm">
          Your account could not be deleted because your subscription would keep
          renewing. Cancel it in{" "}
          <Link to="/settings/billing" className="underline">
            Billing settings
          </Link>{" "}
          first. You need not wait for it to end.
        </p>
      )}
      {deletion === "unchecked" && (
        <p role="alert" className="text-destructive text-sm">
          Your account could not be deleted because your subscription could not
          be checked. Try again later.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <p role="status" className="text-muted-foreground text-sm">
        {message}
      </p>
      <Item variant="outline">
        <ItemContent className="gap-4">
          <ItemTitle>Profile</ItemTitle>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await authClient.updateUser({
                  name: name.trim(),
                  image: image.trim() || null,
                });
                if (result.error)
                  throw new Error(
                    result.error.message ?? "Could not save profile.",
                  );
                await router.invalidate();
                setMessage("Profile saved.");
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor="account-name">Name</FieldLabel>
              <Input
                id="account-name"
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-image">Profile image URL</FieldLabel>
              <Input
                id="account-image"
                type="url"
                value={image}
                placeholder="https://"
                onChange={(event) => setImage(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Saving…" : "Save profile"}
            </Button>
          </form>
        </ItemContent>
      </Item>
      <Item variant="outline">
        <ItemContent className="gap-4">
          <ItemTitle>Email</ItemTitle>
          <ItemDescription>
            Your current email is {user.email}. Verify a new address before it
            becomes your sign-in email.
          </ItemDescription>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await authClient.emailOtp
                  .requestEmailChange({
                    newEmail: email.trim(),
                    fetchOptions: {
                      headers: { "x-captcha-response": captchaToken },
                    },
                  })
                  // Each token works once.
                  .finally(() => {
                    setCaptchaToken("");
                    turnstile.current?.reset();
                  });
                if (result.error)
                  throw new Error(
                    result.error.message ?? "Could not send verification code.",
                  );
                setEmailSentTo(email.trim());
                setOtp("");
                setMessage("Verification code sent to your new address.");
              });
            }}
          >
            <Field>
              <FieldLabel htmlFor="account-email">New email</FieldLabel>
              <Input
                id="account-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            {emailChanged && (
              <Turnstile
                action={AUTH_EMAIL_CAPTCHA_ACTION}
                sitekey={import.meta.env.VITE_TURNSTILE_SITE_KEY ?? ""}
                theme="auto"
                size="flexible"
                className="w-full"
                onLoad={(_id, widget) => {
                  turnstile.current = widget;
                }}
                onVerify={(token) => {
                  setCaptchaToken(token);
                  setCaptchaError("");
                }}
                onError={() =>
                  captchaFailed(
                    "The security check is unavailable. Try again later.",
                  )
                }
                onExpire={() =>
                  captchaFailed(
                    "The security check expired. Complete it again.",
                  )
                }
                onTimeout={() =>
                  captchaFailed(
                    "The security check timed out. Complete it again.",
                  )
                }
                onUnsupported={() =>
                  captchaFailed(
                    "The security check does not support this browser. Try another browser.",
                  )
                }
              />
            )}
            {emailChanged && captchaError && (
              <div className="space-y-2">
                <p role="alert" className="text-destructive text-sm">
                  {captchaError}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (turnstile.current) turnstile.current.reset();
                    else window.location.reload();
                  }}
                >
                  Retry security check
                </Button>
              </div>
            )}
            <Button
              type="submit"
              variant="outline"
              disabled={pending || !emailChanged || !captchaToken}
            >
              Send verification code
            </Button>
          </form>
          {emailSentTo && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await authClient.emailOtp.changeEmail({
                    newEmail: emailSentTo,
                    otp,
                  });
                  if (result.error)
                    throw new Error(
                      result.error.message ??
                        "Could not verify email. Request a new code and try again.",
                    );
                  setEmailSentTo("");
                  setOtp("");
                  await router.invalidate();
                  setMessage("Email updated.");
                });
              }}
            >
              <Field>
                <FieldLabel htmlFor="email-code">
                  Code sent to {emailSentTo}
                </FieldLabel>
                <Input
                  id="email-code"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={otp}
                  onChange={(event) => setOtp(event.target.value)}
                />
              </Field>
              <Button type="submit" disabled={pending}>
                Verify new email
              </Button>
            </form>
          )}
        </ItemContent>
      </Item>
      <TwoFactorSection onMessage={setMessage} onError={setError} />
      <PasskeysSection onMessage={setMessage} onError={setError} />
      <Item variant="outline">
        <ItemContent className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <ItemTitle>Active sessions</ItemTitle>
              <ItemDescription>
                Devices currently signed in to your account.
              </ItemDescription>
            </div>
            {otherSessionCount > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    const result = await authClient.revokeOtherSessions();
                    if (result.error)
                      throw new Error(
                        result.error.message ??
                          "Could not sign out other sessions.",
                      );
                    await loadSessions();
                    setMessage("Signed out of other sessions.");
                  })
                }
              >
                Sign out other sessions
              </Button>
            )}
          </div>
          {sessionsError && (
            <p role="alert" className="text-destructive text-sm">
              {sessionsError}
            </p>
          )}
          {sessionsLoading ? (
            <p className="text-muted-foreground text-sm">Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No active sessions found.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {sessions.map((item) => {
                const isCurrent = item.id === currentSessionId;
                return (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-medium">
                        {summarizeUserAgent(item.userAgent)}
                        {isCurrent && (
                          <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs font-normal">
                            Current session
                          </span>
                        )}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {item.ipAddress ? `${item.ipAddress} · ` : ""}
                        Signed in {formatSessionDate(item.createdAt)} · Expires{" "}
                        {formatSessionDate(item.expiresAt)}
                      </p>
                    </div>
                    {!isCurrent && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void run(async () => {
                            const result = await authClient.revokeSession({
                              token: item.token,
                            });
                            if (result.error)
                              throw new Error(
                                result.error.message ??
                                  "Could not revoke session.",
                              );
                            await loadSessions();
                            setMessage("Session revoked.");
                          })
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ItemContent>
      </Item>
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>Export account data</ItemTitle>
          <ItemDescription>
            Download a ZIP of your account data, AI chats and usage, and the
            saved files of the personal projects you own. Files of projects
            shared with you are not included.
          </ItemDescription>
          <a
            href="/api/account/export"
            download
            className={buttonVariants({
              variant: "outline",
              className: "mt-4 w-fit",
            })}
          >
            Download my data
          </a>
        </ItemContent>
      </Item>
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>Delete account</ItemTitle>
          <ItemDescription>
            Permanently delete your account and personal projects. This cannot
            be undone. You’ll confirm through an email link.
          </ItemDescription>
          <Button
            variant="destructive"
            className="mt-4 w-fit"
            disabled={pending}
            onClick={() => {
              setError("");
              setConfirmDelete(true);
            }}
          >
            Delete account
          </Button>
        </ItemContent>
      </Item>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete your account?</AlertDialogTitle>
          <AlertDialogDescription>
            We’ll send a confirmation link to {user.email}. Following it
            permanently deletes your account and personal projects.
          </AlertDialogDescription>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmDelete(false)}
            >
              Keep account
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  const result = await authClient.deleteUser({
                    callbackURL: "/",
                  });
                  if (result.error)
                    throw new Error(
                      result.error.message ??
                        "Could not request account deletion.",
                    );
                  setConfirmDelete(false);
                  setMessage("Check your email to confirm account deletion.");
                })
              }
            >
              {pending ? "Sending…" : "Send deletion link"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
