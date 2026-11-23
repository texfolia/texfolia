import { IconDownload } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { Checkbox } from "@texfolia/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@texfolia/ui/dialog";
import { useState, useImperativeHandle, type Ref } from "react";

import { decodeSource, type SourceFiles } from "#/features/storage";
import { downloadFile } from "#/features/storage/browser";
import { createZip } from "#/features/storage/zip";
import { buildFileUrl } from "#/lib/build";
import { binaryFetchLimit, mapLimit } from "#/lib/map-limit";
import { useWorkspace } from "#/providers/workspace-provider";

export type ProjectExportHandle = { open: () => void };

export function ProjectExport({
  ref,
  name,
  sources,
}: {
  ref?: Ref<ProjectExportHandle>;
  name: string;
  sources: () => Promise<SourceFiles>;
}) {
  const { build, projectId } = useWorkspace();
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }));
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
        files.push(
          ...(await mapLimit(
            build?.artifacts?.files ?? [],
            binaryFetchLimit,
            async (file) => {
              const response = await fetch(buildFileUrl(projectId, file));
              if (!response.ok)
                throw new Error(
                  "Build changed during export. Try downloading again.",
                );
              return { path: `out/${file.path}`, blob: await response.blob() };
            },
          )),
        );
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export project</DialogTitle>
          <DialogDescription>
            Download a ZIP of the current project sources.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 py-2">
          <Checkbox
            checked={includeBuild}
            disabled={pending || !build?.artifacts}
            onCheckedChange={setIncludeBuild}
          />
          Include generated out/ files
        </label>
        <Button
          size="sm"
          variant="ghost"
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
      </DialogContent>
    </Dialog>
  );
}
