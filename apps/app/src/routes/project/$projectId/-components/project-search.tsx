import { IconLetterCase } from "@tabler/icons-react";
import { useDeferredValue, useEffect, useId, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { searchProject } from "#/lib/project-search";
import { useWorkspace } from "#/providers/workspace-provider";

export type SearchRequest = { sequence: number; query?: string };

export function ProjectSearch({
  active,
  request,
}: {
  active: boolean;
  request: SearchRequest;
}) {
  const { drafts, paths, reveal } = useWorkspace();
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const wasActive = useRef(active);
  useEffect(() => {
    if (request.query) setQuery(request.query);
  }, [request]);
  useEffect(() => {
    // Focus when opened or re-requested, but not when a restored layout mounts.
    const opened = active && !wasActive.current;
    wasActive.current = active;
    if (!active || (!opened && !request.sequence)) return;
    const frame = requestAnimationFrame(() => input.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [active, request]);
  const deferred = useDeferredValue(query);
  // Drafts hold the live collaborative text of every text file, so results
  // include unsaved edits. Binary files have no draft and are never searched.
  const result = active
    ? searchProject(
        [...paths].flatMap(([nodeId, path]) => {
          const draft = drafts.get(nodeId);
          return draft ? [[path, draft.value] as [string, string]] : [];
        }),
        deferred,
        { matchCase },
      )
    : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b p-2">
        <label htmlFor={id} className="sr-only">
          Search project files
        </label>
        <Input
          id={id}
          ref={input}
          type="search"
          value={query}
          placeholder="Search text files…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            const first = result?.files[0]?.matches[0];
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              first
            ) {
              event.preventDefault();
              reveal(
                first.path,
                first.line,
                first.column,
                first.end - first.start,
              );
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="aria-pressed:bg-muted"
          aria-label="Match case"
          title="Match case"
          aria-pressed={matchCase}
          onClick={() => setMatchCase((value) => !value)}
        >
          <IconLetterCase />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {result?.files.map((file) => (
          <section key={file.path} aria-label={file.path} className="py-1">
            <h3
              className="truncate px-2 py-1 text-xs font-medium"
              title={file.path}
            >
              {file.path}{" "}
              <span className="text-muted-foreground font-normal">
                ({file.matches.length})
              </span>
            </h3>
            <ul>
              {file.matches.map((match) => (
                <li key={`${match.line}:${match.column}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto min-h-7 w-full justify-start gap-2 rounded-none py-1 text-left font-normal"
                    title={`${file.path}:${match.line}:${match.column}`}
                    onClick={() =>
                      reveal(
                        file.path,
                        match.line,
                        match.column,
                        match.end - match.start,
                      )
                    }
                  >
                    <span className="text-muted-foreground w-8 shrink-0 text-right tabular-nums">
                      {match.line}
                    </span>
                    <code className="min-w-0 truncate text-xs whitespace-pre">
                      {match.preview.slice(0, match.start)}
                      <mark className="bg-primary/20 text-foreground rounded-xs">
                        {match.preview.slice(match.start, match.end)}
                      </mark>
                      {match.preview.slice(match.end)}
                    </code>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p
        role="status"
        className="text-muted-foreground shrink-0 border-t px-2 py-1 text-xs"
      >
        {!deferred
          ? "Searches text files, including unsaved edits. Binary files are skipped."
          : !result?.total
            ? "No results."
            : `${result.total}${result.truncated ? "+" : ""} ${result.total === 1 ? "result" : "results"} in ${result.files.length} ${result.files.length === 1 ? "file" : "files"}${result.truncated ? ". Refine the search to see more." : ""}`}
      </p>
    </div>
  );
}
