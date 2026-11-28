import { useNavigate } from "@tanstack/react-router";
import { sourcePathSchema } from "@texfolia/contracts";
import { useId, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { importProjectFiles } from "#/lib/projects/project.functions";
import {
  sourceFileKind,
  encodeSource,
  maxSourceFileBytes,
  maxSourceProjectBytes,
} from "#/lib/storage";

export function FilesProjectForm({
  onPendingChange,
}: {
  onPendingChange: (pending: boolean) => void;
}) {
  const navigate = useNavigate();
  const id = useId();
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  function choose(selected: FileList | null) {
    if (!selected?.length) return;
    setError("");
    const next = Array.from(selected);
    if (next.length > 400) {
      setError("Choose at most 400 files.");
      return;
    }
    if (next.some((file) => file.size > maxSourceFileBytes)) {
      setError("Each file must be 10 MiB or smaller.");
      return;
    }
    if (
      next.reduce((total, file) => total + file.size, 0) > maxSourceProjectBytes
    ) {
      setError("Project files must total 50 MiB or less.");
      return;
    }
    setFiles(next);
    if (!name)
      setName(
        next[0]?.webkitRelativePath.split("/")[0] ||
          next[0]?.name.replace(/\.[^.]+$/, "") ||
          "",
      );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        onPendingChange(true);
        setError("");
        try {
          const sources: {
            path: string;
            kind: ReturnType<typeof sourceFileKind>;
            content: string;
          }[] = [];
          for (const file of files) {
            const path = file.webkitRelativePath
              ? file.webkitRelativePath.split("/").slice(1).join("/")
              : file.name;
            const parsed = sourcePathSchema.safeParse(path);
            if (!parsed.success)
              throw new Error(`${path}: ${parsed.error.issues[0]?.message}`);
            const kind = sourceFileKind(file);
            sources.push({
              path: parsed.data,
              kind,
              content: encodeSource(new Uint8Array(await file.arrayBuffer())),
            });
          }
          const created = await importProjectFiles({
            data: { name, files: sources },
          });
          await navigate({
            to: "/project/$projectId",
            params: { projectId: created.id },
          });
        } catch (failure) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Upload failed. Please try again.",
          );
        } finally {
          setPending(false);
          onPendingChange(false);
        }
      }}
    >
      <p className="text-muted-foreground text-sm">
        Bring your LaTeX sources, images, and bibliography. Up to 400 files, 10
        MiB each and 50 MiB total.
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => filesInput.current?.click()}
        >
          Choose files
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => folderInput.current?.click()}
        >
          Choose folder
        </Button>
      </div>
      <input
        ref={filesInput}
        type="file"
        multiple
        className="hidden"
        aria-label="Project files"
        disabled={pending}
        onChange={(event) => {
          choose(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={(node) => {
          folderInput.current = node;
          node?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        className="hidden"
        aria-label="Project folder"
        disabled={pending}
        onChange={(event) => {
          choose(event.target.files);
          event.target.value = "";
        }}
      />
      {files.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-sm font-medium">
            {files.length} file{files.length === 1 ? "" : "s"} selected
          </p>
          <ul className="text-muted-foreground max-h-32 overflow-auto text-xs">
            {files.map((file) => (
              <li
                key={file.webkitRelativePath || file.name}
                className="truncate py-0.5"
              >
                {file.webkitRelativePath || file.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor={id}>Project name</Label>
        <Input
          id={id}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          disabled={pending}
          placeholder="My project"
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending || !files.length}>
        {pending ? "Uploading…" : "Create project"}
      </Button>
    </form>
  );
}
