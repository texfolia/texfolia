import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { renderSVG } from "uqr";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "#/components/ui/item";
import { authClient } from "#/lib/auth/auth-client";
import {
  getAccountSecurityState,
  viewTwoFactorBackupCodes,
} from "#/lib/auth/auth.functions";

function extractTotpSecret(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
}

export function TwoFactorSection({
  onMessage,
  onError,
}: {
  onMessage: (message: string) => void;
  onError: (error: string) => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  // Enrollment state
  const [setupUri, setSetupUri] = useState<string | null>(null);
  const [setupBackupCodes, setSetupBackupCodes] = useState<string[] | null>(
    null,
  );
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [enablePassword, setEnablePassword] = useState("");

  // Backup codes viewer / regeneration state
  const [visibleBackupCodes, setVisibleBackupCodes] = useState<string[] | null>(
    null,
  );
  const [regeneratedSavedConfirmed, setRegeneratedSavedConfirmed] =
    useState(false);
  const [isRegeneratedView, setIsRegeneratedView] = useState(false);
  const [regenerateDialogOpen, setRegenerateDialogOpen] = useState(false);
  const [regeneratePassword, setRegeneratePassword] = useState("");

  // Disable state
  const [disableDialogOpen, setDisableDialogOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");

  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      const state = await getAccountSecurityState();
      setEnabled(state.twoFactorEnabled);
      setHasPassword(state.hasPassword);
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "Could not load two-factor authentication status.",
      );
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  async function copyCodes(codes: string[]) {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      onMessage("Backup codes copied to clipboard.");
    } catch {
      onError("Could not copy backup codes. Select and copy them manually.");
    }
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      onMessage("Setup key copied to clipboard.");
    } catch {
      onError("Could not copy setup key.");
    }
  }

  async function startEnrollment() {
    setBusy(true);
    onError("");
    onMessage("");
    try {
      const result = await authClient.twoFactor.enable({
        method: "totp",
        ...(hasPassword ? { password: enablePassword } : {}),
      });
      if (
        result.error ||
        !result.data ||
        !("totpURI" in result.data) ||
        !result.data.totpURI
      ) {
        throw new Error(
          result.error?.message ?? "Could not start two-factor setup.",
        );
      }
      setSetupUri(result.data.totpURI);
      setSetupBackupCodes(result.data.backupCodes ?? []);
      setSavedConfirmed(false);
      setVerifyCode("");
      setEnablePassword("");
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "Could not start two-factor setup.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyEnrollment() {
    setBusy(true);
    onError("");
    onMessage("");
    try {
      const result = await authClient.twoFactor.verifyTotp({
        code: verifyCode.trim(),
      });
      if (result.error) {
        throw new Error(
          result.error.message ??
            "That code did not match. Check your authenticator app and try again.",
        );
      }
      setSetupUri(null);
      setSetupBackupCodes(null);
      setSavedConfirmed(false);
      setVerifyCode("");
      setEnabled(true);
      await router.invalidate();
      onMessage("Two-factor authentication is now enabled.");
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "Could not verify authenticator code.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleViewBackupCodes() {
    setBusy(true);
    onError("");
    onMessage("");
    try {
      const { backupCodes } = await viewTwoFactorBackupCodes();
      setVisibleBackupCodes(backupCodes);
      setIsRegeneratedView(false);
      setRegeneratedSavedConfirmed(true);
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Could not load backup codes.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerateBackupCodes() {
    setBusy(true);
    onError("");
    onMessage("");
    try {
      const result = await authClient.twoFactor.generateBackupCodes(
        hasPassword ? { password: regeneratePassword } : {},
      );
      if (result.error || !result.data) {
        throw new Error(
          result.error?.message ?? "Could not regenerate backup codes.",
        );
      }
      setRegenerateDialogOpen(false);
      setRegeneratePassword("");
      setVisibleBackupCodes(result.data.backupCodes);
      setIsRegeneratedView(true);
      setRegeneratedSavedConfirmed(false);
      onMessage(
        "New backup codes generated. Previous backup codes no longer work.",
      );
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "Could not regenerate backup codes.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDisableTwoFactor() {
    setBusy(true);
    onError("");
    onMessage("");
    try {
      const result = await authClient.twoFactor.disable(
        hasPassword ? { password: disablePassword } : {},
      );
      if (result.error) {
        throw new Error(
          result.error.message ??
            "Could not disable two-factor authentication.",
        );
      }
      setDisableDialogOpen(false);
      setDisablePassword("");
      setVisibleBackupCodes(null);
      setEnabled(false);
      await router.invalidate();
      onMessage("Two-factor authentication has been disabled.");
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "Could not disable two-factor authentication.",
      );
    } finally {
      setBusy(false);
    }
  }

  const setupSecret = setupUri ? extractTotpSecret(setupUri) : null;
  const qrSvg = setupUri ? renderSVG(setupUri, { border: 2 }) : null;

  return (
    <Item variant="outline">
      <ItemContent className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <ItemTitle>
              Two-factor authentication
              {!loading && (
                <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs font-normal">
                  {enabled ? "Enabled" : "Off"}
                </span>
              )}
            </ItemTitle>
            <ItemDescription>
              Protect your account with an authenticator app (TOTP) and
              single-use backup codes.
            </ItemDescription>
          </div>
        </div>

        {loading ? (
          <p className="text-muted-foreground text-sm">
            Loading two-factor settings…
          </p>
        ) : !enabled && !setupUri ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void startEnrollment();
            }}
          >
            {hasPassword && (
              <Field>
                <FieldLabel htmlFor="two-factor-enable-password">
                  Current password
                </FieldLabel>
                <Input
                  id="two-factor-enable-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={enablePassword}
                  onChange={(event) => setEnablePassword(event.target.value)}
                />
              </Field>
            )}
            <Button
              type="submit"
              variant="outline"
              disabled={busy || (hasPassword && !enablePassword)}
            >
              {busy ? "Starting setup…" : "Set up authenticator app"}
            </Button>
          </form>
        ) : setupUri ? (
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-sm font-medium">
                1. Scan this QR code with your authenticator app
              </p>
              {qrSvg && (
                <div
                  className="inline-block rounded-md border bg-white p-3 [&_svg]:size-44"
                  aria-label="Authenticator app QR code"
                  // uqr generates static deterministic SVG markup from the TOTP URI.
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
              )}
              {setupSecret && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Manual key:</span>
                  <code className="bg-muted rounded px-2 py-1 font-mono select-all">
                    {setupSecret}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copySecret(setupSecret)}
                  >
                    Copy key
                  </Button>
                </div>
              )}
            </div>

            {setupBackupCodes && setupBackupCodes.length > 0 && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    2. Save your recovery backup codes
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copyCodes(setupBackupCodes)}
                  >
                    Copy all
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Store these codes somewhere safe. Each code can be used once
                  if you lose access to your authenticator app.
                </p>
                <ul className="bg-muted/50 grid grid-cols-2 gap-1.5 rounded-md border p-3 font-mono text-xs sm:grid-cols-5">
                  {setupBackupCodes.map((code) => (
                    <li key={code} className="select-all">
                      {code}
                    </li>
                  ))}
                </ul>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={savedConfirmed}
                    onChange={(event) =>
                      setSavedConfirmed(event.target.checked)
                    }
                    className="accent-primary size-4 rounded border"
                  />
                  <span>I have saved these backup codes in a safe place</span>
                </label>
              </div>
            )}

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void verifyEnrollment();
              }}
            >
              <Field>
                <FieldLabel htmlFor="two-factor-verify-code">
                  3. Enter the 6-digit code from your authenticator app
                </FieldLabel>
                <Input
                  id="two-factor-verify-code"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="000000"
                  value={verifyCode}
                  onChange={(event) => setVerifyCode(event.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    verifyCode.trim().length !== 6 ||
                    (Boolean(setupBackupCodes?.length) && !savedConfirmed)
                  }
                >
                  {busy ? "Verifying…" : "Verify and enable"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setSetupUri(null);
                    setSetupBackupCodes(null);
                    setSavedConfirmed(false);
                    setVerifyCode("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void handleViewBackupCodes()}
              >
                View backup codes
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  onError("");
                  setRegeneratePassword("");
                  setRegenerateDialogOpen(true);
                }}
              >
                Regenerate backup codes
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => {
                  onError("");
                  setDisablePassword("");
                  setDisableDialogOpen(true);
                }}
              >
                Disable 2FA
              </Button>
            </div>

            {visibleBackupCodes && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {isRegeneratedView
                      ? "New backup codes"
                      : "Remaining backup codes"}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void copyCodes(visibleBackupCodes)}
                    >
                      Copy all
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isRegeneratedView && !regeneratedSavedConfirmed}
                      onClick={() => setVisibleBackupCodes(null)}
                    >
                      Hide
                    </Button>
                  </div>
                </div>
                {visibleBackupCodes.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    All backup codes have been used. Regenerate a new set.
                  </p>
                ) : (
                  <ul className="bg-muted/50 grid grid-cols-2 gap-1.5 rounded-md border p-3 font-mono text-xs sm:grid-cols-5">
                    {visibleBackupCodes.map((code) => (
                      <li key={code} className="select-all">
                        {code}
                      </li>
                    ))}
                  </ul>
                )}
                {isRegeneratedView && (
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={regeneratedSavedConfirmed}
                      onChange={(event) =>
                        setRegeneratedSavedConfirmed(event.target.checked)
                      }
                      className="accent-primary size-4 rounded border"
                    />
                    <span>I have saved these new backup codes</span>
                  </label>
                )}
              </div>
            )}
          </div>
        )}

        <AlertDialog
          open={regenerateDialogOpen}
          onOpenChange={setRegenerateDialogOpen}
        >
          <AlertDialogContent>
            <AlertDialogTitle>Regenerate backup codes?</AlertDialogTitle>
            <AlertDialogDescription>
              This invalidates all of your existing backup codes and creates a
              fresh set of 10 single-use codes.
            </AlertDialogDescription>
            {hasPassword && (
              <Field className="mt-2">
                <FieldLabel htmlFor="two-factor-regenerate-password">
                  Current password
                </FieldLabel>
                <Input
                  id="two-factor-regenerate-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={regeneratePassword}
                  onChange={(event) =>
                    setRegeneratePassword(event.target.value)
                  }
                />
              </Field>
            )}
            <AlertDialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRegenerateDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={busy || (hasPassword && !regeneratePassword)}
                onClick={() => void handleRegenerateBackupCodes()}
              >
                {busy ? "Generating…" : "Regenerate codes"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={disableDialogOpen}
          onOpenChange={setDisableDialogOpen}
        >
          <AlertDialogContent>
            <AlertDialogTitle>
              Disable two-factor authentication?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your authenticator app and recovery backup codes will be removed,
              and trusted devices will be cleared.
            </AlertDialogDescription>
            {hasPassword && (
              <Field className="mt-2">
                <FieldLabel htmlFor="two-factor-disable-password">
                  Current password
                </FieldLabel>
                <Input
                  id="two-factor-disable-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={disablePassword}
                  onChange={(event) => setDisablePassword(event.target.value)}
                />
              </Field>
            )}
            <AlertDialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setDisableDialogOpen(false)}
              >
                Keep 2FA enabled
              </Button>
              <Button
                variant="destructive"
                disabled={busy || (hasPassword && !disablePassword)}
                onClick={() => void handleDisableTwoFactor()}
              >
                {busy ? "Disabling…" : "Disable 2FA"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemContent>
    </Item>
  );
}
