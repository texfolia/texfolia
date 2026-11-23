import { IconFilePlus, IconFolderPlus } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@texfolia/ui/dialog";
import { Field, FieldError, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import { useId, useState, useImperativeHandle, type Ref } from "react";

import {
  nodeNameSchema,
  newProjectNodePath,
  projectNodePaths,
} from "#/features/projects";
import type { ProjectNode } from "#/features/projects/project.functions";
import { useProjectFiles } from "#/providers/project-files-provider";

export type CreateNodeHandle = {
  start: (kind: "text" | "folder", parentId?: string) => void;
};

export function CreateNodeForm({
  ref,
  hideTrigger = false,
  nodes,
  activeId,
  onCreated,
}: {
  ref?: Ref<CreateNodeHandle>;
  hideTrigger?: boolean;
  nodes: ProjectNode[];
  activeId: string | undefined;
  onCreated: (node: ProjectNode, permanent: boolean) => void;
}) {
  const files = useProjectFiles();
  const id = useId();
  const [kind, setKind] = useState<"text" | "folder" | null>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folders = nodes.filter(
    (node) =>
      node.kind === "folder" && !files.nodes.get(node.id)?.$hasPendingWrites,
  );
  const folderPaths = projectNodePaths(nodes);

  function start(nextKind: "text" | "folder", targetParentId?: string) {
    const active = nodes.find((node) => node.id === activeId);
    const parent = active?.kind === "folder" ? active.id : active?.parentId;
    setParentId(
      targetParentId ??
        parent ??
        folders.find((node) => node.parentId === null)?.id ??
        folders[0]?.id ??
        "",
    );
    setName("");
    setError(null);
    setKind(nextKind);
  }

  useImperativeHandle(ref, () => ({ start }));

  if (!kind)
    return hideTrigger ? null : (
      <div className="flex gap-0">
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={!folders.length}
          title="New file"
          onClick={() => start("text")}
        >
          <IconFilePlus />
          <span className="sr-only">New file</span>
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={!folders.length}
          title="New folder"
          onClick={() => start("folder")}
        >
          <IconFolderPlus />
          <span className="sr-only">New folder</span>
        </Button>
      </div>
    );

  const form = (
    <form
      className="w-full space-y-3 p-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        const parsed = nodeNameSchema.safeParse(name);
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Enter a valid name.");
          return;
        }
        try {
          newProjectNodePath(nodes, parentId, parsed.data);
        } catch (error) {
          setError(
            error instanceof Error ? error.message : "Enter a valid path.",
          );
          return;
        }
        if (
          nodes.some(
            (node) =>
              node.parentId === parentId &&
              node.name.toLowerCase() === parsed.data.toLowerCase(),
          )
        ) {
          setError("A file or folder with this name already exists here.");
          return;
        }
        setError(null);
        setPending(true);
        try {
          const node = await files.create({
            kind,
            parentId,
            name: parsed.data,
          });
          setKind(null);
          if (node.kind === "text") onCreated(node, true);
        } catch (error) {
          setError(
            error instanceof Error
              ? `Could not create this item. ${error.message}`
              : "Could not create this item. Check your connection and try again.",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>
          {kind === "text" ? "File name" : "Folder name"}
        </FieldLabel>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={kind === "text" ? "chapter.tex" : "chapters"}
          autoFocus
          disabled={pending}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-parent`}>In folder</FieldLabel>
        <NativeSelect
          id={`${id}-parent`}
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
          disabled={pending}
          className="w-full"
        >
          {folders.map((folder) => (
            <NativeSelectOption key={folder.id} value={folder.id}>
              {folderPaths.get(folder.id) || folder.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {error && (
        <FieldError id={`${id}-error`} role="alert">
          {error}
        </FieldError>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending
            ? "Creating…"
            : kind === "text"
              ? "Create file"
              : "Create folder"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setKind(null)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
  return hideTrigger ? (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) setKind(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "text" ? "New file" : "New folder"}
          </DialogTitle>
          <DialogDescription>
            Choose a name and folder in this project.
          </DialogDescription>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  ) : (
    form
  );
}
