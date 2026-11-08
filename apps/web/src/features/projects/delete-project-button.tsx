import { IconTrash } from "@tabler/icons-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { toast } from "#/components/ui/toast";
import type { Project } from "#/features/projects/collections";
import { useProjects } from "#/features/projects/context";

export function DeleteProjectButton({
  project,
}: {
  project: Pick<Project, "id" | "name">;
}) {
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setIsDeleting(true);
    setError(null);

    try {
      await projects.remove(project.id);
    } catch {
      toast.add({
        title: "Project was not deleted",
        description: "Your project has been restored. Please try again.",
        type: "error",
      });
      setError("Unable to delete your project. Please try again.");
      setIsDeleting(false);
      return;
    }

    setOpen(false);
    setIsDeleting(false);
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (isDeleting) return;
        setError(null);
        setOpen(nextOpen);
      }}
    >
      <AlertDialogTrigger
        render={<Button size="icon-lg" variant="outline" />}
        aria-label={`Delete ${project.name}`}
      >
        <IconTrash />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project?</AlertDialogTitle>
          <AlertDialogDescription>
            “{project.name}” will be removed from your projects. You won’t be
            able to open it again.
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
            {isDeleting ? "Deleting…" : "Delete project"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
