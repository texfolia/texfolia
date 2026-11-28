import { IconUpload } from "@tabler/icons-react";
import { useId, useRef, useState, useImperativeHandle, type Ref } from "react";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#/components/ui/dialog";
import { uploadProjectFiles } from "#/lib/projects";
import type { ProjectNode } from "#/lib/projects/project.functions";
import { readDroppedFiles, type DroppedFile } from "#/lib/storage/browser";
import { useProjectFiles } from "#/providers/project-files-provider";

export type UploadSourceHandle = {
  open: (parentId?: string) => void;
  drop: (parentId: string, entries: Array<FileSystemEntry | File>) => void;
};

export function UploadSource({
  ref,
  hideTrigger = false,
  nodes,
  activeId,
  onCreated,
}: {
  ref?: Ref<UploadSourceHandle>;
  hideTrigger?: boolean;
  nodes: ProjectNode[];
  activeId: string | undefined;
  onCreated: (node: ProjectNode, permanent: boolean) => void;
}) {
  const files = useProjectFiles();
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const targetFolder = useRef<string | undefined>(undefined);
  const active = nodes.find((node) => node.id === activeId);
  const parentId =
    (active?.kind === "folder" ? active.id : active?.parentId) ??
    nodes.find((node) => node.kind === "folder" && node.parentId === null)?.id;

  async function upload(source: Promise<DroppedFile[]>) {
    const targetParentId = targetFolder.current ?? parentId;
    targetFolder.current = undefined;
    if (!targetParentId || pending) return;
    setError("");
    setPending(true);
    try {
      const dropped = await source;
      const uploaded = await uploadProjectFiles({
        files,
        nodes,
        targetParentId,
        dropped,
      });
      if (uploaded.length === 1 && uploaded[0]) onCreated(uploaded[0], true);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Upload failed. Try again when online.",
      );
    } finally {
      setPending(false);
    }
  }

  useImperativeHandle(ref, () => ({
    open: (parentId) => {
      targetFolder.current = parentId;
      input.current?.click();
    },
    drop: (parentId, entries) => {
      targetFolder.current = parentId;
      void upload(readDroppedFiles(entries));
    },
  }));

  return (
    <div className="min-w-0">
      {!hideTrigger && (
        <Button
          size="icon-xs"
          variant="ghost"
          title="Upload file"
          aria-label={pending ? "Uploading…" : "Upload file"}
          disabled={pending || !parentId}
          aria-describedby={error ? `${id}-error` : undefined}
          onClick={() => {
            targetFolder.current = undefined;
            input.current?.click();
          }}
        >
          <IconUpload />
        </Button>
      )}
      <input
        ref={input}
        type="file"
        className="hidden"
        aria-label="Upload project source"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(Promise.resolve([{ path: [file.name], file }]));
        }}
      />
      {error &&
        (hideTrigger ? (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setError("");
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Upload failed</DialogTitle>
                <DialogDescription role="alert">{error}</DialogDescription>
              </DialogHeader>
              <Button variant="ghost" onClick={() => setError("")}>
                Close
              </Button>
            </DialogContent>
          </Dialog>
        ) : (
          <p
            id={`${id}-error`}
            role="alert"
            className="text-destructive pt-2 text-xs"
          >
            {error}
          </p>
        ))}
    </div>
  );
}
