import { IconArrowBackUp, IconFilePencil } from "@tabler/icons-react";
import { cn } from "cn";
import { useMemo, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "#/components/ui/trace";

import { diffCounts, type DiffLine, diffReplacement } from "../diff";
import type { AssistantEditor, RevertOutcome } from "../editor";
import type { AssistantChange } from "../revert";

type FileChange = Extract<
  AssistantChange,
  { kind: "edit" | "create" | "rename" }
>;

export function isFileChange(change: AssistantChange): change is FileChange {
  return ["edit", "create", "rename"].includes(change.kind);
}

export function describeChange(change: AssistantChange) {
  switch (change.kind) {
    case "edit":
      return `Edited ${change.path}`;
    case "create":
      return `Created ${change.path}`;
    case "rename":
      return `Renamed ${change.path} to ${change.newPath}`;
    case "delete":
      return `Deleted ${change.path}`;
    case "git":
      return change.action === "pull" ? "Pulled from Git" : "Switched branch";
  }
}

function Diff({ diff, label }: { diff: DiffLine[]; label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      tabIndex={0}
      className="bg-background text-foreground max-h-64 overflow-auto rounded-md border py-1 font-mono text-xs"
    >
      {diff.map(({ kind, parts }, index) => (
        <div
          key={index}
          className={cn(
            "flex gap-2 px-2 whitespace-pre-wrap wrap-anywhere",
            kind === "removed" && "bg-destructive/10",
            kind === "added" && "bg-success/10",
          )}
        >
          <span
            aria-hidden="true"
            className="text-muted-foreground w-2 shrink-0 select-none"
          >
            {kind === "removed" ? "−" : kind === "added" ? "+" : ""}
          </span>
          <span className="min-w-0 flex-1">
            {kind !== "same" && (
              <span className="sr-only">
                {kind === "removed" ? "Removed: " : "Added: "}
              </span>
            )}
            {parts.map(({ text, changed }, part) =>
              changed ? (
                <span
                  key={part}
                  className={cn(
                    "rounded-xs",
                    kind === "removed" ? "bg-destructive/25" : "bg-success/25",
                  )}
                >
                  {text}
                </span>
              ) : (
                text
              ),
            )}
            {!parts.length && " "}
          </span>
        </div>
      ))}
    </div>
  );
}

const outcomeText: Record<RevertOutcome["outcome"], string> = {
  reverted: "Reverted.",
  already: "Already reverted.",
  partial: "Partly reverted.",
  skipped: "Not reverted.",
};

function Revert({
  label,
  change,
  editor,
  disabled,
}: {
  label: string;
  change: AssistantChange;
  editor: AssistantEditor;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RevertOutcome>();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || busy || !editor.canWrite}
        title={
          editor.canWrite ? undefined : "You have view access to this project."
        }
        onClick={() => {
          setBusy(true);
          setResult(undefined);
          void editor
            .revert([change])
            .then(([outcome]) => setResult(outcome))
            .finally(() => setBusy(false));
        }}
      >
        <IconArrowBackUp />
        {busy ? "Reverting…" : label}
      </Button>
      {result && (
        <span
          role={result.outcome === "skipped" ? "alert" : "status"}
          className="min-w-0 flex-1"
        >
          {outcomeText[result.outcome]} {result.reason}
        </span>
      )}
    </div>
  );
}

/** A file change the assistant made, with its diff and a way back. */
export function ChangeCard({
  change,
  editor,
  disabled,
  defaultOpen,
}: {
  change: FileChange;
  editor: AssistantEditor;
  /** While the assistant works, its next edit may build on this one. */
  disabled: boolean;
  defaultOpen: boolean;
}) {
  const diffs = useMemo(
    () =>
      change.kind === "edit"
        ? change.edits.map((edit) =>
            diffReplacement(edit.oldText, edit.newText),
          )
        : change.kind === "create"
          ? [diffReplacement("", change.content)]
          : [],
    [change],
  );
  const counts = diffCounts(diffs.flat());
  const path = change.kind === "rename" ? change.newPath : change.path;
  return (
    <Trace>
      <TraceCollapsible defaultOpen={defaultOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <IconFilePencil />
            </TraceIcon>
            <TraceTitle>{describeChange(change)}</TraceTitle>
            {diffs.length > 0 && (
              <TraceDescription>
                +{counts.added} −{counts.removed}
              </TraceDescription>
            )}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="space-y-2 text-xs">
          {change.kind === "edit" &&
            change.edits.map((edit, index) => (
              <div key={index} className="space-y-1">
                <Diff
                  diff={diffs[index] ?? []}
                  label={`Edit ${index + 1} of ${change.path}`}
                />
                {change.edits.length > 1 && (
                  <Revert
                    label="Revert this edit"
                    change={{ ...change, edits: [edit] }}
                    editor={editor}
                    disabled={disabled}
                  />
                )}
              </div>
            ))}
          {change.kind === "create" && change.content && (
            <Diff diff={diffs[0] ?? []} label={`Contents of ${change.path}`} />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Revert
              label={
                change.kind === "edit"
                  ? change.edits.length > 1
                    ? "Revert all edits"
                    : "Revert edit"
                  : change.kind === "create"
                    ? "Remove file"
                    : "Undo rename"
              }
              change={change}
              editor={editor}
              disabled={disabled}
            />
            <Button
              size="xs"
              variant="ghost"
              disabled={!editor.files.includes(path)}
              onClick={() => editor.reveal(path)}
            >
              Open file
            </Button>
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
