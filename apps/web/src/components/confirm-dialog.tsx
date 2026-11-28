import { type ComponentProps, type ReactNode, useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";

export type Confirmation = {
  title: string;
  description: ReactNode;
  /** What the confirming button does, such as "Delete thread". */
  action: string;
  onConfirm: () => void;
};

/** Asks before an action that cannot be undone, in place of window.confirm. */
export function ConfirmDialog({
  confirmation,
  onClose,
  finalFocus,
}: {
  confirmation: Confirmation | null;
  onClose: () => void;
  /** What to focus once closed, instead of what had focus before. */
  finalFocus?: ComponentProps<typeof AlertDialogContent>["finalFocus"];
}) {
  // Kept while the dialog animates closed.
  const [shown, setShown] = useState(confirmation);
  if (confirmation && confirmation !== shown) setShown(confirmation);
  return (
    <AlertDialog
      open={!!confirmation}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.title}</AlertDialogTitle>
          <AlertDialogDescription>{shown?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onClose();
              confirmation?.onConfirm();
            }}
          >
            {shown?.action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
