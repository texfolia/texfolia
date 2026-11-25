import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@texfolia/ui/alert-dialog";
import { Button } from "@texfolia/ui/button";
import { useState } from "react";

import {
  deleteTemplate,
  setTemplatePublished,
} from "#/lib/templates/template.functions";

/** Lets a template's publisher hide it, show it again, or delete it. */
export function TemplateActions({
  template,
  onChanged,
  onDeleted,
}: {
  template: { id: string; title: string; published: boolean };
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The template could not be changed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label={`${template.published ? "Unpublish" : "Republish"} ${template.title}`}
          onClick={() =>
            void run(async () => {
              await setTemplatePublished({
                data: {
                  templateId: template.id,
                  published: !template.published,
                },
              });
              await onChanged();
            })
          }
        >
          {template.published ? "Unpublish" : "Republish"}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          aria-label={`Delete ${template.title}`}
          onClick={() => {
            setError("");
            setConfirming(true);
          }}
        >
          Delete
        </Button>
      </div>
      {error && !confirming && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete “{template.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The template and its URL stop working for everyone. This cannot be
            undone. Projects already made from it are kept.
          </AlertDialogDescription>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep template
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await deleteTemplate({ data: { templateId: template.id } });
                  setConfirming(false);
                  await onDeleted();
                })
              }
            >
              {busy ? "Deleting…" : "Delete template"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
