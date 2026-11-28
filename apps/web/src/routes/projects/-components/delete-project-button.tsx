import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@texfolia/ui/alert-dialog";
import { toast } from "@texfolia/ui/toast";
import { useState } from "react";

import { trashRetentionDays } from "#/lib/projects";
import { restoreProject, type Project } from "#/lib/projects/project.functions";
import { useProjects } from "#/providers/projects-provider";

export function DeleteProjectButton({
  project,
  open,
  onOpenChange,
}: {
  project: Pick<Project, "id" | "name">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const projects = useProjects();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setIsDeleting(true);
    setError(null);

    try {
      await projects.remove(project.id);
    } catch {
      toast.add({
        title: "Project was not moved to the trash",
        description: "Please try again.",
        type: "error",
      });
      setError("Unable to move your project to the trash. Please try again.");
      setIsDeleting(false);
      return;
    }

    onOpenChange(false);
    setIsDeleting(false);
    const id = toast.add({
      title: `“${project.name}” moved to the trash`,
      type: "success",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toast.close(id);
          void undo();
        },
      },
    });
  }

  async function undo() {
    try {
      await restoreProject({ data: { projectId: project.id } });
      await projects.refresh();
    } catch {
      toast.add({
        title: "Could not restore project",
        description: "Restore it from the trash.",
        type: "error",
      });
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (isDeleting) return;
        setError(null);
        onOpenChange(nextOpen);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move project to trash?</AlertDialogTitle>
          <AlertDialogDescription>
            “{project.name}” will be closed for everyone, and its share links
            will stop working. You can restore it from the trash for{" "}
            {trashRetentionDays} days. After that it is permanently deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isDeleting}
            onClick={() => void handleDelete()}
          >
            {isDeleting ? "Moving…" : "Move to trash"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
