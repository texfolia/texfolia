import {
  IconArrowLeft,
  IconFileText,
  IconBrandGit,
  IconFolderPlus,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { getTemplateAccount, listTemplates } from "#/lib/template.functions";

import { FilesProjectForm } from "./files-project-form";
import { GitImport } from "./git-import";
import { ProjectForm } from "./project-form";

type Source = "template" | "git" | "files";
const sources = [
  {
    id: "template",
    title: "Template",
    description: "Start blank or choose a ready-made document.",
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

function Templates({
  onPendingChange,
}: {
  onPendingChange: (pending: boolean) => void;
}) {
  const [page, setPage] = useState(0);
  const [templates, setTemplates] = useState<
    Awaited<ReturnType<typeof listTemplates>>
  >([]);
  const [destinations, setDestinations] = useState<
    { id: string; name: string }[]
  >([]);
  const [selected, setSelected] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void Promise.all([listTemplates({ data: { page } }), getTemplateAccount()])
      .then(([rows, account]) => {
        if (active) {
          setTemplates(rows);
          setDestinations(account.destinations);
        }
      })
      .catch(() => {
        if (active)
          setError(
            "Templates could not be loaded. You can still start blank, or try again.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, attempt]);
  function markPending(value: boolean) {
    setPending(value);
    onPendingChange(value);
  }
  return (
    <div className="space-y-5">
      <fieldset disabled={pending} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Choose a template</legend>
        <div className="max-h-52 space-y-1 overflow-auto rounded-lg border p-1">
          {[
            {
              id: "blank",
              title: "Blank",
              description: "An empty main.tex, ready for your ideas.",
            },
            ...templates,
          ].map((template) => (
            <label
              key={template.id}
              className="hover:bg-accent has-checked:bg-accent flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5"
            >
              <input
                type="radio"
                name="template"
                value={template.id}
                checked={template.id === (selected?.id ?? "blank")}
                onChange={() =>
                  setSelected(template.id === "blank" ? null : template)
                }
                className="accent-primary shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {template.title}
                </span>
                <span className="text-muted-foreground block truncate text-xs">
                  {template.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {loading && (
        <p role="status" className="text-muted-foreground text-xs">
          Loading templates…
        </p>
      )}
      {error && (
        <div role="alert" className="text-destructive text-sm">
          {error}{" "}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </Button>
        </div>
      )}
      {(page > 0 || templates.length === 24) && (
        <div className="flex items-center justify-between text-xs">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending || loading || page === 0}
            onClick={() => {
              setSelected(null);
              setPage((value) => value - 1);
            }}
          >
            Previous
          </Button>
          <span className="text-muted-foreground">Page {page + 1}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending || loading || templates.length < 24}
            onClick={() => {
              setSelected(null);
              setPage((value) => value + 1);
            }}
          >
            Next
          </Button>
        </div>
      )}
      <ProjectForm
        key={selected?.id ?? "blank"}
        template={selected}
        destinations={destinations}
        onPendingChange={markPending}
      />
    </div>
  );
}

export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [source, setSource] = useState<Source | null>(() =>
    sessionStorage.getItem("texfolia.git.import") ? "git" : null,
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
            {source === "template" && (
              <Templates onPendingChange={setPending} />
            )}
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
