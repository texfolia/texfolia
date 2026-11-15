import { IconUpload } from "@tabler/icons-react";
import { useId, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { newProjectNodePath } from "#/lib/project-paths";
import { encodeSource, maxSourceFileBytes } from "#/lib/project-source";
import type { ProjectNode } from "#/lib/project.functions";
import { useProjectFiles } from "#/providers/project-files-provider";

export function UploadSource({
  nodes,
  activeId,
  onCreated,
}: {
  nodes: ProjectNode[];
  activeId: string | undefined;
  onCreated: (node: ProjectNode, permanent: boolean) => void;
}) {
  const files = useProjectFiles();
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = nodes.find((node) => node.id === activeId);
  const parentId =
    (active?.kind === "folder" ? active.id : active?.parentId) ??
    nodes.find((node) => node.kind === "folder" && node.parentId === null)?.id;

  async function upload(file: File) {
    if (!parentId || pending) return;
    setError("");
    setPending(true);
    try {
      newProjectNodePath(nodes, parentId, file.name);
      if (file.size > maxSourceFileBytes)
        throw new Error("File exceeds 10 MiB. Choose a smaller file.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind =
        /\.(tex|ltx|latex|bib|sty|cls|clo|bst|bbx|cbx|lbx|cfg|def|json|yaml|yml|toml|ini|csv|tsv|md|markdown|txt|svg|xml|lua|py|r|jl|sh|js|ts|css|html)$/i.test(
          file.name,
        ) || file.type.startsWith("text/")
          ? "text"
          : "binary";
      const created = await files.create({
        parentId,
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
      <Button
        size="icon-sm"
        variant="ghost"
        title="Upload file"
        aria-label={pending ? "Uploading…" : "Upload file"}
        disabled={pending || !parentId}
        aria-describedby={error ? `${id}-error` : undefined}
        onClick={() => input.current?.click()}
      >
        <IconUpload />
      </Button>
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
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-destructive pt-2 text-xs"
        >
          {error}
        </p>
      )}
    </div>
  );
}
