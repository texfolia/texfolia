import { IconUpload } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@texfolia/ui/dialog";
import { useId, useRef, useState, useImperativeHandle, type Ref } from "react";

import { newProjectNodePath } from "#/lib/projects";
import type { ProjectNode } from "#/lib/projects/project.functions";
import {
  encodeSource,
  maxSourceFileBytes,
  sourceFileKind,
} from "#/lib/storage";
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
      // Validate every path before creating anything, so a bad drop leaves
      // the tree unchanged. Dropped folders merge into existing ones.
      const planned: Pick<ProjectNode, "id" | "parentId" | "name" | "kind">[] =
        [...nodes];
      const steps: {
        id: string;
        parentId: string;
        name: string;
        file?: File;
      }[] = [];
      for (const { path, file } of dropped) {
        if (file.size > maxSourceFileBytes)
          throw new Error(
            `${path.join("/")} exceeds 10 MiB. Choose a smaller file.`,
          );
        let parent = targetParentId;
        for (const [index, name] of path.entries()) {
          const last = index === path.length - 1;
          const existing = planned.find(
            (node) =>
              node.parentId === parent &&
              node.name.toLowerCase() === name.toLowerCase(),
          );
          if (existing?.kind === "folder" && !last) {
            parent = existing.id;
            continue;
          }
          if (existing)
            throw new Error(
              `${path.slice(0, index + 1).join("/")}: A file or folder with this name already exists here.`,
            );
          newProjectNodePath(planned, parent, name);
          const id = crypto.randomUUID();
          planned.push({
            id,
            parentId: parent,
            name,
            kind: last ? "binary" : "folder",
          });
          steps.push({
            id,
            parentId: parent,
            name,
            file: last ? file : undefined,
          });
          parent = id;
        }
      }
      const created = new Map<string, ProjectNode>();
      for (const step of steps) {
        const parentId = created.get(step.parentId)?.id ?? step.parentId;
        const node = await files.create(
          step.file
            ? {
                parentId,
                name: step.name,
                kind: sourceFileKind(step.file),
                content: encodeSource(
                  new Uint8Array(await step.file.arrayBuffer()),
                ),
              }
            : { parentId, name: step.name, kind: "folder" },
        );
        created.set(step.id, node);
      }
      const uploaded = steps.filter((step) => step.file);
      const only = uploaded.length === 1 && created.get(uploaded[0]?.id ?? "");
      if (only) onCreated(only, true);
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
