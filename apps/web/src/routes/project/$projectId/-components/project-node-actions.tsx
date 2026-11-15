import { IconDots } from "@tabler/icons-react";
import { cn } from "cn";
import { useState } from "react";

import { editorDialogChrome } from "#/components/editor-chrome";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { projectNodePaths } from "#/lib/project-paths";
import type { ProjectNode } from "#/lib/project.functions";
import { useProjectFiles } from "#/providers/project-files-provider";

export function ProjectNodeActions({
  node,
  nodes,
}: {
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
      <DialogTrigger
        render={<Button size="icon-xs" variant="ghost" />}
        aria-label={`Manage ${node.name}`}
        className="bg-sidebar absolute top-0.5 right-0.5 z-10 opacity-100 md:opacity-0 md:group-focus-within/node:opacity-100 md:group-hover/node:opacity-100"
      >
        <IconDots />
      </DialogTrigger>
      <DialogContent className={cn("p-4", editorDialogChrome)}>
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
              variant="outline"
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
  );
}
