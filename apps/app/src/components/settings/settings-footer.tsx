import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@texfolia/ui/alert-dialog";
import { Button } from "@texfolia/ui/button";

import { useSettingsEditing } from "#/providers/settings-provider";

export function SettingsFooter({
  onSave,
  onCancel,
}: {
  onSave?: () => void;
  onCancel?: () => void;
}) {
  const settings = useSettingsEditing();
  return (
    <footer className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-4">
      <div className="mr-auto min-w-0 basis-full text-sm sm:basis-auto">
        <p role="status" className="text-muted-foreground">
          {!settings.ready
            ? "Loading preferences…"
            : settings.saving
              ? "Saving settings…"
              : settings.dirty
                ? "Unsaved changes"
                : "All changes saved"}
        </p>
        {settings.error && (
          <p role="alert" className="text-destructive mt-1">
            {settings.error}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        disabled={settings.saving}
        onClick={() => {
          settings.discard();
          onCancel?.();
        }}
      >
        Cancel
      </Button>
      <Button
        variant="outline"
        disabled={!settings.ready || settings.saving || !settings.dirty}
        onClick={() => void settings.apply()}
      >
        Apply
      </Button>
      <Button
        disabled={!settings.ready || settings.saving}
        onClick={() =>
          void settings.apply(true).then((saved) => {
            if (saved) onSave?.();
          })
        }
      >
        Save
      </Button>
    </footer>
  );
}

export function SettingsCloseGuard({
  open,
  onKeepEditing,
  onDiscard,
  onApply,
}: {
  open?: boolean;
  onKeepEditing?: () => void;
  onDiscard?: () => void;
  onApply?: () => void;
}) {
  const settings = useSettingsEditing();
  return (
    <AlertDialog
      open={open ?? settings.closeGuard}
      onOpenChange={(next) => {
        if (!next) {
          settings.setCloseGuard(false);
          onKeepEditing?.();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Unsaved settings changes</AlertDialogTitle>
        <AlertDialogDescription>
          Apply your changes and keep Settings open, or discard them before
          leaving.
        </AlertDialogDescription>
        {settings.error && (
          <p role="alert" className="text-destructive text-sm">
            {settings.error}
          </p>
        )}
        <AlertDialogFooter>
          <Button
            variant="outline"
            disabled={settings.saving}
            onClick={() => {
              settings.setCloseGuard(false);
              onKeepEditing?.();
            }}
          >
            Keep editing
          </Button>
          <Button
            variant="outline"
            disabled={settings.saving}
            onClick={() => {
              settings.discard();
              onDiscard?.();
            }}
          >
            Discard
          </Button>
          <Button
            disabled={settings.saving}
            onClick={() =>
              void settings.apply().then((saved) => {
                if (saved) onApply?.();
              })
            }
          >
            {settings.saving ? "Applying…" : "Apply"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
