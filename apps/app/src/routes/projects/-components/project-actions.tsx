import {
  IconArrowUpRight,
  IconDots,
  IconDownload,
  IconPencil,
  IconTag,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { downloadFile } from "@texfolia/storage/browser";
import { createZip } from "@texfolia/storage/zip";
import { Button } from "@texfolia/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@texfolia/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@texfolia/ui/dropdown-menu";
import { Input } from "@texfolia/ui/input";
import { Label } from "@texfolia/ui/label";
import { toast } from "@texfolia/ui/toast";
import { useId, useState } from "react";

import { projectPaths } from "#/lib/project-paths";
import {
  getProject,
  renameProject,
  setProjectTags,
  type Project,
} from "#/lib/project.functions";
import { projectTagsSchema, renameProjectSchema } from "#/lib/project.schema";
import { useProjects } from "#/providers/projects-provider";
import { ProjectAccessPanel } from "#/routes/project/$projectId/-components/project-collaboration";

import { DeleteProjectButton } from "./delete-project-button";

type Action = "rename" | "tags" | "share" | "delete";
function EditProject({
  project,
  mode,
  onClose,
}: {
  project: Project;
  mode: "rename" | "tags";
  onClose: () => void;
}) {
  const store = useProjects();
  const id = useId();
  const [value, setValue] = useState(
    mode === "tags" ? project.tags.join(", ") : project.name,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>
            {mode === "tags" ? "Edit your tags" : "Rename project"}
          </DialogTitle>
          <DialogDescription>
            {mode === "tags"
              ? "These labels are private to you. Separate tags with commas; up to 12 tags, 32 characters each."
              : `Choose a new name for “${project.name}”.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending) return;
            setPending(true);
            setError("");
            try {
              if (mode === "tags")
                await setProjectTags({
                  data: projectTagsSchema.parse({
                    projectId: project.id,
                    tags: value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  }),
                });
              else
                await renameProject({
                  data: renameProjectSchema.parse({
                    projectId: project.id,
                    name: value,
                  }),
                });
              await store.refresh();
              onClose();
            } catch {
              setError(
                mode === "tags"
                  ? "Could not save tags. Use up to 12 tags of 32 characters and try again."
                  : "Could not rename project. Try a different name.",
              );
            } finally {
              setPending(false);
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={id}>
              {mode === "tags" ? "Your tags" : "Project name"}
            </Label>
            <Input
              id={id}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              required={mode === "rename"}
              disabled={pending}
              placeholder={mode === "tags" ? "research, draft" : "Project name"}
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              type="button"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectActions({ project }: { project: Project }) {
  const [action, setAction] = useState<Action | null>(null);
  const [pending, setPending] = useState(false);
  const store = useProjects();
  async function download() {
    if (pending) return;
    setPending(true);
    try {
      const details = await getProject({ data: { projectId: project.id } });
      const files = [];
      for (const [nodeId, path] of projectPaths(details.nodes)) {
        const response = await fetch(`/api/sources/${project.id}/${nodeId}`);
        if (!response.ok) throw new Error("Source unavailable");
        files.push({ path, blob: await response.blob() });
      }
      downloadFile(await createZip(files), `${project.name}.zip`);
    } catch {
      toast.add({
        title: "Could not download project",
        description: "Please try again.",
        type: "error",
      });
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" />}
          aria-label={`Actions for ${project.name}`}
          disabled={pending}
        >
          <IconDots />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem
            render={
              <Link
                to="/project/$projectId"
                params={{ projectId: project.id }}
              />
            }
          >
            <IconArrowUpRight />
            Open
          </DropdownMenuItem>
          {project.canWrite && (
            <DropdownMenuItem onClick={() => setAction("rename")}>
              <IconPencil />
              Rename
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setAction("tags")}>
            <IconTag />
            Your tags
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAction("share")}>
            <IconUsers />
            Share
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void download()}>
            <IconDownload />
            Download ZIP
          </DropdownMenuItem>
          {project.canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setAction("delete")}
              >
                <IconTrash />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {(action === "rename" || action === "tags") && (
        <EditProject
          project={project}
          mode={action}
          onClose={() => setAction(null)}
        />
      )}
      {action === "share" && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setAction(null);
              void store.refresh();
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Share project</DialogTitle>
              <DialogDescription>
                Manage access to “{project.name}”.
              </DialogDescription>
            </DialogHeader>
            <ProjectAccessPanel projectId={project.id} />
          </DialogContent>
        </Dialog>
      )}
      <DeleteProjectButton
        project={project}
        open={action === "delete"}
        onOpenChange={(next) => {
          if (!next) setAction(null);
        }}
      />
    </>
  );
}
