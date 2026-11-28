import { useId, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";

/** Asks for the password of an encrypted PDF. */
export function PdfPassword({
  filename,
  incorrect,
  onSubmit,
  onCancel,
}: {
  filename: string;
  /** The last password did not open the PDF. */
  incorrect: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [password, setPassword] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Password required</DialogTitle>
          <DialogDescription>
            {filename} is protected. Enter its password to open it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(password);
          }}
        >
          <Field data-invalid={incorrect || undefined}>
            <FieldLabel htmlFor={`${id}-password`}>PDF password</FieldLabel>
            <Input
              id={`${id}-password`}
              type="password"
              autoComplete="off"
              autoFocus
              required
              value={password}
              aria-invalid={incorrect || undefined}
              aria-describedby={incorrect ? `${id}-error` : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            {incorrect && (
              <p
                id={`${id}-error`}
                role="alert"
                className="text-destructive text-sm"
              >
                That password is incorrect. Try again.
              </p>
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Open PDF</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
