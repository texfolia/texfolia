import { useCallback, useEffect, useState } from "react";

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

const authenticatorNames: Record<string, string> = {
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Apple Passwords",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "b78a0a55-6ef8-d246-a042-ba0f6d55050c": "LastPass",
  "b84e4048-15dc-4dd0-8640-f4f60813c8af": "NordPass",
  "50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
  "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": "Keeper",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

function getAuthenticatorName(aaguid: string | undefined): string | undefined {
  const normalized = aaguid?.trim().toLowerCase();
  if (!normalized || normalized === "00000000-0000-0000-0000-000000000000") {
    return undefined;
  }
  return authenticatorNames[normalized];
}

type PasskeyRecord = {
  id: string;
  name?: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt?: Date | string | null;
  aaguid?: string | null;
};

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

function formatPasskeyDate(value: Date | string | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

export function PasskeysSection({
  onMessage,
  onError,
}: {
  onMessage: (message: string) => void;
  onError: (error: string) => void;
}) {
  const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingPasskey, setDeletingPasskey] = useState<PasskeyRecord | null>(
    null,
  );

  const supported =
    typeof window !== "undefined" && typeof PublicKeyCredential !== "undefined";

  const loadPasskeys = useCallback(async () => {
    setLoading(true);
    setListError("");
    try {
      const result = await authClient.passkey.listUserPasskeys();
      if (result.error) {
        throw new Error(result.error.message ?? "Could not load passkeys.");
      }
      setPasskeys((result.data ?? []) as PasskeyRecord[]);
    } catch (cause) {
      setListError(
        cause instanceof Error ? cause.message : "Could not load passkeys.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPasskeys();
  }, [loadPasskeys]);

  async function handleAddPasskey() {
    setBusy(true);
    onError("");
    onMessage("");
    try {
      const trimmed = newName.trim();
      const result = await authClient.passkey.addPasskey(
        trimmed ? { name: trimmed } : {},
      );
      if (result?.error) {
        throw new Error(result.error.message ?? "Could not register passkey.");
      }
      setNewName("");
      await loadPasskeys();
      onMessage("Passkey added.");
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Could not register passkey.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRenamePasskey(id: string) {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    setBusy(true);
    onError("");
    onMessage("");
    try {
      const result = await authClient.passkey.updatePasskey({
        id,
        name: trimmed,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Could not rename passkey.");
      }
      setRenamingId(null);
      setRenameValue("");
      await loadPasskeys();
      onMessage("Passkey renamed.");
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Could not rename passkey.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePasskey(id: string) {
    setBusy(true);
    onError("");
    onMessage("");
    try {
      const result = await authClient.passkey.deletePasskey({ id });
      if (result.error) {
        throw new Error(result.error.message ?? "Could not delete passkey.");
      }
      setDeletingPasskey(null);
      await loadPasskeys();
      onMessage("Passkey removed.");
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Could not delete passkey.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Item variant="outline">
      <ItemContent className="gap-4">
        <div>
          <ItemTitle>Passkeys</ItemTitle>
          <ItemDescription>
            Sign in faster with Touch ID, Face ID, Windows Hello, or a hardware
            security key.
          </ItemDescription>
        </div>

        {!supported && (
          <p className="text-muted-foreground text-sm">
            This browser does not support passkeys. You can still manage
            existing passkeys below.
          </p>
        )}

        {supported && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAddPasskey();
            }}
          >
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor="passkey-name">
                Passkey name (optional)
              </FieldLabel>
              <Input
                id="passkey-name"
                maxLength={64}
                placeholder="e.g. MacBook Touch ID"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
            </Field>
            <Button type="submit" variant="outline" disabled={busy}>
              {busy ? "Registering…" : "Add passkey"}
            </Button>
          </form>
        )}

        {listError && (
          <p role="alert" className="text-destructive text-sm">
            {listError}
          </p>
        )}

        {loading ? (
          <p className="text-muted-foreground text-sm">Loading passkeys…</p>
        ) : passkeys.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No passkeys registered yet.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {passkeys.map((item) => {
              const displayName =
                item.name ||
                getAuthenticatorName(item.aaguid ?? undefined) ||
                "Passkey";
              const isRenaming = renamingId === item.id;
              const added = formatPasskeyDate(item.createdAt);
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm"
                >
                  {isRenaming ? (
                    <form
                      className="flex flex-1 flex-wrap items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void handleRenamePasskey(item.id);
                      }}
                    >
                      <Input
                        aria-label="New passkey name"
                        maxLength={64}
                        required
                        className="max-w-xs"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        disabled={busy || !renameValue.trim()}
                      >
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setRenamingId(null);
                          setRenameValue("");
                        }}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <>
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-medium">
                          {displayName}
                          {item.backedUp && (
                            <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs font-normal">
                              Synced
                            </span>
                          )}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {item.deviceType === "multiDevice"
                            ? "Multi-device passkey"
                            : "Device-bound key"}
                          {added ? ` · Added ${added}` : ""}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setRenamingId(item.id);
                            setRenameValue(item.name ?? displayName);
                          }}
                        >
                          Rename
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setDeletingPasskey(item)}
                        >
                          Remove
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <AlertDialog
          open={deletingPasskey !== null}
          onOpenChange={(open) => {
            if (!open) setDeletingPasskey(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogTitle>Remove passkey?</AlertDialogTitle>
            <AlertDialogDescription>
              You will no longer be able to sign in with{" "}
              {deletingPasskey?.name ||
                getAuthenticatorName(deletingPasskey?.aaguid ?? undefined) ||
                "this passkey"}
              .
            </AlertDialogDescription>
            <AlertDialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setDeletingPasskey(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy || !deletingPasskey}
                onClick={() => {
                  if (deletingPasskey)
                    void handleDeletePasskey(deletingPasskey.id);
                }}
              >
                {busy ? "Removing…" : "Remove passkey"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemContent>
    </Item>
  );
}
