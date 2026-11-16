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
import { newProjectNodePath } from "#/lib/project-paths";
import {
  encodeSource,
  maxSourceFileBytes,
  sourceFileKind,
} from "#/lib/project-source";
import type { ProjectNode } from "#/lib/project.functions";
import { useProjectFiles } from "#/providers/project-files-provider";

export type UploadSourceHandle = { open: (parentId?: string) => void };

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
  useImperativeHandle(ref, () => ({
    open: (parentId) => {
      targetFolder.current = parentId;
      input.current?.click();
    },
  }));
  const active = nodes.find((node) => node.id === activeId);
  const parentId =
    (active?.kind === "folder" ? active.id : active?.parentId) ??
    nodes.find((node) => node.kind === "folder" && node.parentId === null)?.id;

  async function upload(file: File) {
    const targetParentId = targetFolder.current ?? parentId;
    targetFolder.current = undefined;
    if (!targetParentId || pending) return;
    setError("");
    setPending(true);
    try {
      newProjectNodePath(nodes, targetParentId, file.name);
      if (file.size > maxSourceFileBytes)
        throw new Error("File exceeds 10 MiB. Choose a smaller file.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = sourceFileKind(file);
      const created = await files.create({
        parentId: targetParentId,
        name: file.name,
        kind,
        content: encodeSource(bytes),
      });
      onCreated(created, true);
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
          if (file) void upload(file);
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
