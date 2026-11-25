import { Button } from "@texfolia/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@texfolia/ui/dialog";
import { Input } from "@texfolia/ui/input";
import { useState } from "react";

import type { AssistantThread } from "../threads";

export type ThreadRequest = {
  kind: "rename" | "delete";
  thread: AssistantThread;
};

/** Asks for a chat's new name, or whether to delete it. */
export function ThreadDialog({
  request,
  saving,
  onSubmit,
  onClose,
}: {
  request: ThreadRequest | undefined;
  saving: boolean;
  /** The title is omitted to delete the chat. */
  onSubmit: (thread: AssistantThread, title?: string) => void;
  onClose: () => void;
}) {
  // Kept while the dialog animates closed.
  const [shown, setShown] = useState(request);
  if (request && request !== shown) setShown(request);
  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent>
        {shown?.kind === "rename" && (
          <RenameThread
            key={shown.thread.id}
            thread={shown.thread}
            saving={saving}
            onSubmit={onSubmit}
            onClose={onClose}
          />
        )}
        {shown?.kind === "delete" && (
          <DeleteThread
            thread={shown.thread}
            saving={saving}
            onSubmit={onSubmit}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type FormProps = {
  thread: AssistantThread;
  saving: boolean;
  onSubmit: (thread: AssistantThread, title?: string) => void;
  onClose: () => void;
};

function RenameThread({ thread, saving, onSubmit, onClose }: FormProps) {
  const [title, setTitle] = useState(thread.title);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename chat</DialogTitle>
        <DialogDescription>
          Choose a name for this conversation.
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(thread, title);
        }}
      >
        <Input
          aria-label="Chat name"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          required
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </>
  );
}

function DeleteThread({ thread, saving, onSubmit, onClose }: FormProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete chat</DialogTitle>
        <DialogDescription>
          Delete “{thread.title}” and its messages? This cannot be undone.
        </DialogDescription>
      </DialogHeader>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={saving}
          onClick={() => onSubmit(thread)}
        >
          {saving ? "Saving…" : "Delete"}
        </Button>
      </div>
    </>
  );
}
