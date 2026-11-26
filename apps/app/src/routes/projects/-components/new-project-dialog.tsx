import {
  IconArrowLeft,
  IconBrandGit,
  IconFileText,
  IconFolderPlus,
} from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@texfolia/ui/dialog";
import { useState } from "react";

import { readSession } from "#/lib/session-storage";

import { FilesProjectForm } from "./files-project-form";
import { GitImport } from "./git-import";
import { ProjectForm } from "./project-form";

type Source = "blank" | "git" | "files";
const sources = [
  {
    id: "blank",
    title: "Blank",
    description: "An empty main.tex, ready for your ideas.",
    icon: IconFileText,
  },
  {
    id: "git",
    title: "Git repository",
    description: "Import from GitHub or GitLab, with history.",
    icon: IconBrandGit,
  },
  {
    id: "files",
    title: "Files or folder",
    description: "Upload the sources you already have.",
    icon: IconFolderPlus,
  },
] satisfies {
  id: Source;
  title: string;
  description: string;
  icon: typeof IconFileText;
}[];

export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [source, setSource] = useState<Source | null>(() =>
    readSession("texfolia.git.import") ? "git" : null,
  );
  const [pending, setPending] = useState(false);
  const selection = sources.find((item) => item.id === source);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[90svh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            {selection
              ? selection.description
              : "Choose how you’d like to begin."}
          </DialogDescription>
        </DialogHeader>
        {source ? (
          <div className="space-y-4">
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setSource(null)}
            >
              <IconArrowLeft />
              All options
            </Button>
            {source === "blank" && <ProjectForm onPendingChange={setPending} />}
            {source === "git" && <GitImport onPendingChange={setPending} />}
            {source === "files" && (
              <FilesProjectForm onPendingChange={setPending} />
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {sources.map(({ id, title, description, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSource(id)}
                className="hover:bg-accent focus-visible:ring-ring flex flex-col items-start gap-3 rounded-xl border p-5 text-left transition-colors outline-none focus-visible:ring-2"
              >
                <Icon className="text-muted-foreground size-6" />
                <span className="font-medium">{title}</span>
                <span className="text-muted-foreground text-sm leading-relaxed">
                  {description}
                </span>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
