import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@texfolia/ui/alert-dialog";
import { Button } from "@texfolia/ui/button";
import { Field, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from "@texfolia/ui/item";
import { useRef, useState } from "react";

import { authClient } from "#/features/auth/auth-client";
export const Route = createFileRoute("/settings/account")({
  component: AccountPage,
});
function AccountPage() {
  const { user } = Route.useRouteContext();
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [image, setImage] = useState(user.image ?? "");
  const [email, setEmail] = useState(user.email);
  const [emailSentTo, setEmailSentTo] = useState("");
  const [otp, setOtp] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Account</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Manage your profile and sign-in email.
        </p>
      </div>
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
                const result = await authClient.emailOtp.requestEmailChange({
                  newEmail: email.trim(),
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
            <Button
              type="submit"
              variant="outline"
              disabled={pending || email.trim() === user.email}
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
