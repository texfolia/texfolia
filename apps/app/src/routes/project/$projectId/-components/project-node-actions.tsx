import { projectNodePaths } from "@texfolia/projects";
import { Button } from "@texfolia/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@texfolia/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@texfolia/ui/dialog";
import { Input } from "@texfolia/ui/input";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import { useState, type ReactNode } from "react";

import type { ProjectNode } from "#/lib/project.functions";
import { useProjectFiles } from "#/providers/project-files-provider";

export function ProjectNodeActions({
  node,
  nodes,
  children,
  canManage,
  onOpen,
  onCreate,
  onUpload,
  onDownload,
}: {
  children: ReactNode;
  canManage: boolean;
  onOpen: () => void;
  onCreate: (kind: "text" | "folder") => void;
  onUpload: () => void;
  onDownload: () => void;
  node: ProjectNode;
  nodes: ProjectNode[];
}) {
  const files = useProjectFiles();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const paths = projectNodePaths(nodes);
  const descendants = new Set([node.id]);
  for (let count = -1; count !== descendants.size;) {
    count = descendants.size;
    for (const item of nodes)
      if (item.parentId && descendants.has(item.parentId))
        descendants.add(item.id);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setOpen(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The file could not be updated. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />} className="min-w-0">
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {node.kind !== "folder" && (
          <ContextMenuItem onClick={onOpen}>Open</ContextMenuItem>
        )}
        {node.kind !== "folder" && (
          <ContextMenuItem onClick={onDownload}>Download</ContextMenuItem>
        )}
        {node.kind === "folder" && canManage && (
          <>
            <ContextMenuItem onClick={() => onCreate("text")}>
              New file
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCreate("folder")}>
              New folder
            </ContextMenuItem>
            <ContextMenuItem onClick={onUpload}>Upload</ContextMenuItem>
          </>
        )}
        <ContextMenuItem
          onClick={() => {
            void navigator.clipboard
              .writeText(paths.get(node.id) || node.name)
              .catch(() =>
                setError(
                  "Use your browser’s clipboard shortcut to copy the path.",
                ),
              );
          }}
        >
          Copy path
        </ContextMenuItem>
        {canManage && node.parentId && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => {
                setDeleting(false);
                setOpen(true);
              }}
            >
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                setDeleting(false);
                setOpen(true);
              }}
            >
              Move
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onClick={() => {
                setDeleting(true);
                setOpen(true);
              }}
            >
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) {
            setOpen(next);
            setError("");
            setDeleting(false);
          }
        }}
      >
        <DialogContent className="p-4">
          <DialogHeader>
            <DialogTitle>
              {deleting ? "Delete" : "Manage"} {node.name}
            </DialogTitle>
            <DialogDescription>
              {deleting
                ? `This removes ${node.kind === "folder" ? "the folder and every file inside it" : "the file"}. Committed versions remain in git history. Download any content you need before continuing.`
                : "Rename this item or move it to another folder."}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {deleting ? (
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setDeleting(false)}
              >
                Back
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await files.nodes.delete(node.id).when("settled");
                    await files.refresh();
                  })
                }
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </Button>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void run(() =>
                  files.rename(
                    node.id,
                    String(data.get("name")),
                    String(data.get("parentId")),
                  ),
                );
              }}
            >
              <label className="block space-y-2 text-sm">
                <span>Name</span>
                <Input
                  name="name"
                  required
                  defaultValue={node.name}
                  disabled={busy}
                />
              </label>
              <label className="block space-y-2 text-sm">
                <span>Folder</span>
                <NativeSelect
                  aria-label="Folder"
                  name="parentId"
                  defaultValue={node.parentId ?? ""}
                  disabled={busy}
                  className="w-full"
                >
                  {nodes
                    .filter(
                      (item) =>
                        item.kind === "folder" && !descendants.has(item.id),
                    )
                    .map((item) => (
                      <NativeSelectOption key={item.id} value={item.id}>
                        {paths.get(item.id) || item.name}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </label>
              <div className="flex justify-between gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setDeleting(true)}
                >
                  Delete…
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </ContextMenu>
  );
}
