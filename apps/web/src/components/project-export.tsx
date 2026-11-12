import { IconDownload } from "@tabler/icons-react";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { buildFileUrl } from "#/lib/build";
import { downloadFile } from "#/lib/download-file";
import { decodeSource, type SourceFiles } from "#/lib/project-source";
import { createZip } from "#/lib/zip";
import { useWorkspace } from "#/providers/workspace-provider";

export function ProjectExport({
  name,
  sources,
}: {
  name: string;
  sources: () => Promise<SourceFiles>;
}) {
  const { build, projectId } = useWorkspace();
  const [includeBuild, setIncludeBuild] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    setPending(true);
    setError("");
    try {
      const files = Object.entries(await sources()).map(([path, content]) => ({
        path,
        blob: new Blob([
          typeof content === "string" ? content : decodeSource(content.base64),
        ]),
      }));
      if (includeBuild)
        for (const file of build?.artifacts?.files ?? []) {
          const response = await fetch(buildFileUrl(projectId, file));
          if (!response.ok)
            throw new Error(
              "Build changed during export. Try downloading again.",
            );
          files.push({ path: `out/${file.path}`, blob: await response.blob() });
        }
      downloadFile(await createZip(files), `${name}.zip`);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not export project. Try again.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <details className="border-t px-3 py-2 text-xs">
      <summary className="cursor-pointer py-1">Export project</summary>
      <label className="flex items-center gap-2 py-2">
        <input
          type="checkbox"
          checked={includeBuild}
          disabled={pending || !build?.artifacts}
          onChange={(event) => setIncludeBuild(event.target.checked)}
        />
        Include generated out/ files
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => void download()}
      >
        <IconDownload />
        {pending ? "Exporting…" : "Download zip"}
      </Button>
      {error && (
        <p role="alert" className="text-destructive pt-2">
          {error}
        </p>
      )}
    </details>
  );
}
