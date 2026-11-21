import { useId, useState, useImperativeHandle, type Ref } from "react";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import {
  invalidProjectPaths,
  projectNodePaths,
  renamedProjectNodes,
} from "#/lib/project-paths";
import type { ProjectNode } from "#/lib/project.functions";
import { useProjectFiles } from "#/providers/project-files-provider";

export type RepairSourcePathsHandle = { open: () => void };

export function RepairSourcePaths({
  ref,
  nodes,
  canWrite,
}: {
  ref?: Ref<RepairSourcePathsHandle>;
  nodes: ProjectNode[];
  canWrite: boolean;
}) {
  const files = useProjectFiles();
  const id = useId();
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }));
  const [nodeId, setNodeId] = useState("");
  const [parentId, setParentId] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const invalid = invalidProjectPaths(nodes);
  if (!invalid.length) return null;
  const paths = projectNodePaths(nodes);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
    >
      <DialogContent className="max-h-[85svh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Repair source paths</DialogTitle>
          <DialogDescription>
            Rename or move files so the project can compile.
          </DialogDescription>
        </DialogHeader>
        <p role="alert">These paths prevent compilation:</p>
        <ul className="list-disc space-y-2 pl-4">
          {invalid.map(({ id, path, error }) => (
            <li key={id} className="wrap-anywhere">
              <span className="font-medium">{path}</span>: {error}
            </li>
          ))}
        </ul>
        <p>
          File → Export project keeps a copy of your sources. Rename affected
          files or parent folders, or move them closer to the root. Update LaTeX
          references. File contents stay unchanged.
        </p>
        {canWrite ? (
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending) return;
              setError("");
              try {
                renamedProjectNodes(nodes, nodeId, name, parentId);
                setPending(true);
                await files.rename(nodeId, name, parentId);
                setNodeId("");
                setName("");
              } catch (error) {
                setError(
                  error instanceof Error
                    ? error.message
                    : "Could not rename. Check your connection and try again.",
                );
              } finally {
                setPending(false);
              }
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${id}-node`}>File or folder</FieldLabel>
              <NativeSelect
                id={`${id}-node`}
                value={nodeId}
                disabled={pending}
                required
                className="w-full"
                onChange={(event) => {
                  setNodeId(event.target.value);
                  setParentId(
                    nodes.find((node) => node.id === event.target.value)
                      ?.parentId ?? "",
                  );
                  setName(
                    nodes.find((node) => node.id === event.target.value)
                      ?.name ?? "",
                  );
                  setError("");
                }}
              >
                <NativeSelectOption value="">
                  Choose a file or folder
                </NativeSelectOption>
                {nodes
                  .filter((node) => node.parentId !== null)
                  .map((node) => (
                    <NativeSelectOption key={node.id} value={node.id}>
                      {paths.get(node.id)}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-parent`}>In folder</FieldLabel>
              <NativeSelect
                id={`${id}-parent`}
                value={parentId}
                disabled={pending || !nodeId}
                required
                className="w-full"
                onChange={(event) => setParentId(event.target.value)}
              >
                {nodes
                  .filter(
                    (node) => node.kind === "folder" && node.id !== nodeId,
                  )
                  .map((node) => (
                    <NativeSelectOption key={node.id} value={node.id}>
                      {paths.get(node.id)}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>New name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                disabled={pending || !nodeId}
                onChange={(event) => setName(event.target.value)}
                required
                aria-invalid={!!error}
                aria-describedby={error ? `${id}-error` : undefined}
              />
            </Field>
            {error && (
              <FieldError id={`${id}-error`} role="alert">
                {error}
              </FieldError>
            )}
            <Button type="submit" size="sm" disabled={pending || !nodeId}>
              {pending ? "Renaming…" : "Rename"}
            </Button>
          </form>
        ) : (
          <p>Ask a project editor to rename these files or folders.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
