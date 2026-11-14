import { IconFilePlus, IconFolderPlus } from "@tabler/icons-react";
import { useId, useState } from "react";

import { Button } from "#/components/ui/button";
import { Field, FieldError, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { nodeNameSchema } from "#/lib/project-node.schema";
import { newProjectNodePath, projectNodePaths } from "#/lib/project-paths";
import type { ProjectNode } from "#/lib/project.functions";
import { useProjectFiles } from "#/providers/project-files-provider";

export function CreateNodeForm({
  nodes,
  activeId,
  onCreated,
}: {
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

  function start(nextKind: "text" | "folder") {
    const active = nodes.find((node) => node.id === activeId);
    const parent = active?.kind === "folder" ? active.id : active?.parentId;
    setParentId(
      parent ??
        folders.find((node) => node.parentId === null)?.id ??
        folders[0]?.id ??
        "",
    );
    setName("");
    setError(null);
    setKind(nextKind);
  }

  if (!kind)
    return (
      <div className="flex gap-1 px-2 pb-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!folders.length}
          onClick={() => start("text")}
        >
          <IconFilePlus />
          New file
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!folders.length}
          onClick={() => start("folder")}
        >
          <IconFolderPlus />
          New folder
        </Button>
      </div>
    );

  return (
    <form
      className="space-y-3 p-2"
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
        <select
          id={`${id}-parent`}
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
          disabled={pending}
          className="border-input bg-background w-full rounded-md border px-2 py-1 text-sm"
        >
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folderPaths.get(folder.id) || folder.name}
            </option>
          ))}
        </select>
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
}
