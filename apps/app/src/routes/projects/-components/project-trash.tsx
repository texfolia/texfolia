import { IconRestore, IconTrash } from "@tabler/icons-react";
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
import { Button } from "@texfolia/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@texfolia/ui/empty";
import { toast } from "@texfolia/ui/toast";
import { useEffect, useState } from "react";

import { trashRetentionDays } from "#/lib/projects";
import {
  deleteTrashedProject,
  getTrashedProjects,
  restoreProject,
  type TrashedProject,
} from "#/lib/projects/project.functions";
import { useProjects } from "#/providers/projects-provider";

function TrashDate({ date }: { date: Date }) {
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}
    </time>
  );
}

export function ProjectTrash() {
  const store = useProjects();
  const [rows, setRows] = useState<TrashedProject[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busyId, setBusyId] = useState<string>();
  const [confirming, setConfirming] = useState<TrashedProject>();
  useEffect(() => {
    let active = true;
    setFailed(false);
    getTrashedProjects()
      .then((next) => {
        if (active) setRows(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  function drop(id: string) {
    setRows((current) => current?.filter((row) => row.id !== id));
  }
  async function restore(row: TrashedProject) {
    setBusyId(row.id);
    try {
      const restored = await restoreProject({ data: { projectId: row.id } });
      drop(row.id);
      toast.add({ title: `Restored “${restored.name}”`, type: "success" });
    } catch {
      toast.add({
        title: "Could not restore project",
        description: "Please try again.",
        type: "error",
      });
      return;
    } finally {
      setBusyId(undefined);
    }
    await store.refresh().catch(() => {});
  }
  async function remove(row: TrashedProject) {
    setBusyId(row.id);
    try {
      await deleteTrashedProject({ data: { projectId: row.id } });
      drop(row.id);
      setConfirming(undefined);
    } catch {
      toast.add({
        title: "Could not delete project",
        description: "Please try again.",
        type: "error",
      });
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Projects are permanently deleted {trashRetentionDays} days after they
          are moved here.
        </p>
      </div>
      {failed ? (
        <p role="alert" className="text-destructive text-sm">
          The trash could not be loaded.{" "}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </Button>
        </p>
      ) : !rows ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading trash…
        </p>
      ) : rows.length === 0 ? (
        <Empty className="min-h-[55svh] border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconTrash />
            </EmptyMedia>
            <EmptyTitle className="text-2xl">Trash is empty</EmptyTitle>
            <EmptyDescription className="max-w-sm">
              Projects you move to the trash appear here until they are
              permanently deleted.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y rounded-xl border">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3"
            >
              <div className="min-w-48 flex-1">
                <p className="font-medium wrap-anywhere">{row.name}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {row.organizationName ?? "Personal project"} · Moved{" "}
                  <TrashDate date={row.deletedAt} /> · Deletes on{" "}
                  <TrashDate date={row.expiresAt} />
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Restore ${row.name}`}
                  disabled={busyId !== undefined}
                  onClick={() => void restore(row)}
                >
                  <IconRestore />
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  aria-label={`Permanently delete ${row.name}`}
                  disabled={busyId !== undefined}
                  onClick={() => setConfirming(row)}
                >
                  Delete permanently
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {confirming && (
        <AlertDialog
          open
          onOpenChange={(next) => {
            if (!next && busyId === undefined) setConfirming(undefined);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Permanently delete project?</AlertDialogTitle>
              <AlertDialogDescription>
                “{confirming.name}” and its files, comments, and chats will be
                deleted for everyone. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busyId !== undefined}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busyId !== undefined}
                onClick={() => void remove(confirming)}
              >
                {busyId ? "Deleting…" : "Delete permanently"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
