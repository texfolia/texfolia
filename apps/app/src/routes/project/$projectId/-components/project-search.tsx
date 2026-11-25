import {
  IconChecks,
  IconChevronDown,
  IconChevronRight,
  IconLetterCase,
  IconRegex,
  IconReplace,
} from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { Input } from "@texfolia/ui/input";
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDraftSources } from "#/hooks/use-draft-sources";
import { mapLimit } from "#/lib/map-limit";
import {
  planSingleReplacement,
  planTextReplacements,
  searchProject,
  type ProjectSearchMatch,
} from "#/lib/projects";
import { draftSources } from "#/lib/workspace/file-drafts";
import {
  useWorkspace,
  useWorkspaceActions,
} from "#/providers/workspace-provider";

export type SearchRequest = { sequence: number; query?: string };

const replaceConcurrency = 4;

export function ProjectSearch({
  active,
  request,
}: {
  active: boolean;
  request: SearchRequest;
}) {
  const { drafts, reveal, editDocument } = useWorkspaceActions();
  const { paths, canWrite } = useWorkspace();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState("");
  const [replaceNotice, setReplaceNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const replaceId = useId();
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
  const deferredReplacement = useDeferredValue(replacement);
  const replaceVisible = canWrite && showReplace;

  // Drafts hold the live text of open files and the saved text of the others,
  // so results include unsaved edits. Binary files have no draft.
  const textEntries = useDraftSources(drafts, paths, active);
  const idsByPath = useMemo(
    () => new Map(textEntries.map(({ nodeId, path }) => [path, nodeId])),
    [textEntries],
  );

  const shownReplacement = replaceVisible ? deferredReplacement : undefined;
  const result = useMemo(
    () =>
      active
        ? searchProject(
            textEntries.map(
              ({ path, text }) => [path, text] as [string, string],
            ),
            deferred,
            { matchCase, regex: useRegex, replacement: shownReplacement },
          )
        : undefined,
    [active, textEntries, deferred, matchCase, useRegex, shownReplacement],
  );

  const canReplace =
    canWrite &&
    !replacing &&
    !!query &&
    !result?.error &&
    (result?.total ?? 0) > 0;

  function clearFeedback() {
    setReplaceError("");
    setReplaceNotice("");
  }

  async function replaceMatch(match: ProjectSearchMatch) {
    if (!canWrite || replacing || result?.error) return;
    const nodeId = idsByPath.get(match.path);
    if (!nodeId) return;
    setReplacing(true);
    clearFeedback();
    try {
      let applied = false;
      const insert = match.replacement ?? replacement;
      await editDocument(nodeId, (file) => {
        const edit = planSingleReplacement(file.text.toString(), match, insert);
        if (edit) applied = file.applyEdits([edit]);
      });
      setReplaceNotice(
        applied
          ? `Replaced 1 match in ${match.path}.`
          : `No change in ${match.path}.`,
      );
    } catch (error) {
      setReplaceError(
        error instanceof Error
          ? error.message
          : `Could not replace in ${match.path}.`,
      );
    } finally {
      setReplacing(false);
    }
  }

  async function replaceInFile(path: string) {
    if (!canWrite || replacing || !query) return;
    const nodeId = idsByPath.get(path);
    if (!nodeId) return;
    const check = planTextReplacements("", query, replacement, {
      matchCase,
      regex: useRegex,
    });
    if (check.error) {
      setReplaceError(check.error);
      return;
    }
    setReplacing(true);
    clearFeedback();
    try {
      let replacedCount = 0;
      await editDocument(nodeId, (file) => {
        const plan = planTextReplacements(
          file.text.toString(),
          query,
          replacement,
          { matchCase, regex: useRegex },
        );
        if (plan.error) throw new Error(plan.error);
        if (plan.edits.length && file.applyEdits(plan.edits)) {
          replacedCount = plan.edits.length;
        }
      });
      setReplaceNotice(
        replacedCount
          ? `Replaced ${replacedCount} ${replacedCount === 1 ? "match" : "matches"} in ${path}.`
          : `No changes in ${path}.`,
      );
    } catch (error) {
      setReplaceError(
        error instanceof Error
          ? error.message
          : `Could not replace in ${path}.`,
      );
    } finally {
      setReplacing(false);
    }
  }

  async function replaceAll() {
    if (!canWrite || replacing || !query) return;
    const check = planTextReplacements("", query, replacement, {
      matchCase,
      regex: useRegex,
    });
    if (check.error) {
      setReplaceError(check.error);
      return;
    }
    const targets = draftSources(paths, drafts).filter(({ text }) => {
      const plan = planTextReplacements(text, query, replacement, {
        matchCase,
        regex: useRegex,
      });
      return plan.edits.length > 0;
    });
    if (!targets.length) return;
    setReplacing(true);
    clearFeedback();
    let replacedMatches = 0;
    let modifiedFiles = 0;
    const failures: string[] = [];
    try {
      await mapLimit(targets, replaceConcurrency, async ({ nodeId, path }) => {
        try {
          await editDocument(nodeId, (file) => {
            const plan = planTextReplacements(
              file.text.toString(),
              query,
              replacement,
              { matchCase, regex: useRegex },
            );
            if (plan.error) throw new Error(plan.error);
            if (plan.edits.length && file.applyEdits(plan.edits)) {
              replacedMatches += plan.edits.length;
              modifiedFiles++;
            }
          });
        } catch (error) {
          failures.push(
            `${path}: ${error instanceof Error ? error.message : "replace failed"}`,
          );
        }
      });
      if (failures.length) {
        setReplaceError(
          `Failed to replace in ${failures.length} ${failures.length === 1 ? "file" : "files"} (${failures[0]}).`,
        );
      }
      if (replacedMatches > 0) {
        setReplaceNotice(
          `Replaced ${replacedMatches} ${replacedMatches === 1 ? "match" : "matches"} in ${modifiedFiles} ${modifiedFiles === 1 ? "file" : "files"}.`,
        );
      } else if (!failures.length) {
        setReplaceNotice("No changes made.");
      }
    } finally {
      setReplacing(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b p-2">
        <div className="flex items-center gap-1">
          {canWrite && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Toggle replace"
              title="Toggle replace"
              aria-expanded={showReplace}
              onClick={() => setShowReplace((value) => !value)}
            >
              {showReplace ? <IconChevronDown /> : <IconChevronRight />}
            </Button>
          )}
          <label htmlFor={searchId} className="sr-only">
            Search project files
          </label>
          <Input
            id={searchId}
            ref={input}
            type="search"
            value={query}
            aria-invalid={!!result?.error}
            placeholder="Search text files…"
            onChange={(event) => {
              setQuery(event.target.value);
              clearFeedback();
            }}
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
            onClick={() => {
              setMatchCase((value) => !value);
              clearFeedback();
            }}
          >
            <IconLetterCase />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="aria-pressed:bg-muted"
            aria-label="Use regular expression"
            title="Use regular expression"
            aria-pressed={useRegex}
            onClick={() => {
              setUseRegex((value) => !value);
              clearFeedback();
            }}
          >
            <IconRegex />
          </Button>
        </div>
        {replaceVisible && (
          <div className="flex items-center gap-1 pl-8">
            <label htmlFor={replaceId} className="sr-only">
              Replace with
            </label>
            <Input
              id={replaceId}
              type="text"
              value={replacement}
              disabled={replacing}
              placeholder={useRegex ? "Replace… ($1, $&)" : "Replace…"}
              onChange={(event) => {
                setReplacement(event.target.value);
                clearFeedback();
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing &&
                  canReplace
                ) {
                  event.preventDefault();
                  void replaceAll();
                }
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Replace all"
              title="Replace all (Ctrl/Cmd+Enter)"
              disabled={!canReplace}
              onClick={() => void replaceAll()}
            >
              <IconChecks />
            </Button>
          </div>
        )}
        {(result?.error || replaceError) && (
          <p role="alert" className="text-destructive text-xs wrap-anywhere">
            {result?.error || replaceError}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {result?.files.map((file) => (
          <section key={file.path} aria-label={file.path} className="py-1">
            <div className="flex items-center gap-1 px-2 py-1">
              <h3
                className="min-w-0 flex-1 truncate text-xs font-medium"
                title={file.path}
              >
                {file.path}{" "}
                <span className="text-muted-foreground font-normal">
                  ({file.matches.length})
                </span>
              </h3>
              {replaceVisible && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Replace all in ${file.path}`}
                  title={`Replace all in ${file.path}`}
                  disabled={replacing || !!result.error}
                  onClick={() => void replaceInFile(file.path)}
                >
                  <IconReplace />
                </Button>
              )}
            </div>
            <ul>
              {file.matches.map((match) => (
                <li
                  key={`${match.line}:${match.column}:${match.from}:${match.to}`}
                  className="flex items-center"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto min-h-7 min-w-0 flex-1 justify-start gap-2 rounded-none py-1 text-left font-normal"
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
                      {replaceVisible ? (
                        <>
                          {match.end > match.start && (
                            <del className="bg-destructive/20 text-destructive rounded-xs line-through">
                              {match.preview.slice(match.start, match.end)}
                            </del>
                          )}
                          {match.replacement ? (
                            <ins className="bg-primary/20 text-foreground rounded-xs no-underline">
                              {match.replacement}
                            </ins>
                          ) : null}
                        </>
                      ) : (
                        <mark className="bg-primary/20 text-foreground rounded-xs">
                          {match.preview.slice(match.start, match.end)}
                        </mark>
                      )}
                      {match.preview.slice(match.end)}
                    </code>
                  </Button>
                  {replaceVisible && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="mr-1 shrink-0"
                      aria-label={`Replace match at ${file.path}:${match.line}:${match.column}`}
                      title="Replace match"
                      disabled={replacing || !!result.error}
                      onClick={() => void replaceMatch(match)}
                    >
                      <IconReplace />
                    </Button>
                  )}
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
        {replaceNotice
          ? replaceNotice
          : result?.error
            ? "Fix the regular expression to search or replace."
            : !deferred
              ? "Searches text files, including unsaved edits. Binary files are skipped."
              : !result?.total
                ? "No results."
                : `${result.total}${result.truncated ? "+" : ""} ${result.total === 1 ? "result" : "results"} in ${result.files.length} ${result.files.length === 1 ? "file" : "files"}${result.truncated ? ". Refine the search to see more." : ""}`}
      </p>
    </div>
  );
}
