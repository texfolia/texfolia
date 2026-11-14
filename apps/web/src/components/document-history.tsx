import { IconDownload, IconRefresh } from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
import { diffLines } from "diff";
import type { IDockviewPanelProps } from "dockview-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  historyRetentionDays,
  type DocumentVersion,
} from "#/lib/document-history";
import {
  compareDocumentHistory,
  createDocumentVersion,
  listDocumentHistory,
  nameDocumentVersion,
  restoreDocumentVersion,
} from "#/lib/document-history.functions";
import { downloadFile } from "#/lib/download-file";
import { useProjectFiles } from "#/providers/project-files-provider";
import { useWorkspace } from "#/providers/workspace-provider";

const emptySubscribe = () => () => {};
const noStatus = () => undefined;
const noText = () => "";
const versionKinds = {
  automatic: "Automatic version",
  named: "Named version",
  restore: "Restored version",
  "before-restore": "Before restore",
};
function versionName(version: DocumentVersion) {
  return version.label ?? versionKinds[version.kind];
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "History could not be loaded. Try again.";
}

export function DocumentHistoryPanel({
  params,
  api,
}: IDockviewPanelProps<{ nodeId?: string }>) {
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 767px)");
    let maximizedHere = false;
    const layout = () => {
      if (narrow.matches && api.isActive && !api.isMaximized()) {
        api.maximize();
        maximizedHere = true;
      } else if ((!narrow.matches || !api.isActive) && maximizedHere) {
        maximizedHere = false;
        api.exitMaximized();
      }
    };
    layout();
    narrow.addEventListener("change", layout);
    const active = api.onDidActiveChange(layout);
    return () => {
      narrow.removeEventListener("change", layout);
      active.dispose();
      if (maximizedHere) api.exitMaximized();
    };
  }, [api]);
  const files = useProjectFiles();
  const { data: nodes } = useLiveQuery(files.nodes);
  const workspace = useWorkspace();
  const [chosenId, setChosenId] = useState(params.nodeId ?? "");
  const textNodes = nodes.filter((node) => node.kind === "text");
  const nodeId = textNodes.some((node) => node.id === chosenId)
    ? chosenId
    : textNodes[0]?.id;
  return (
    <section
      aria-label="Document history"
      className="flex size-full min-h-0 flex-col text-sm"
    >
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <label htmlFor="history-document" className="font-medium">
          Document
        </label>
        <select
          id="history-document"
          value={nodeId ?? ""}
          onChange={(event) => setChosenId(event.target.value)}
          className="bg-background min-w-0 flex-1 rounded-md border px-2 py-1.5"
        >
          {!textNodes.length && <option value="">No text documents</option>}
          {textNodes.map((node) => (
            <option key={node.id} value={node.id}>
              {workspace.paths.get(node.id) ?? node.name}
            </option>
          ))}
        </select>
      </div>
      {nodeId ? (
        <DocumentVersions key={nodeId} nodeId={nodeId} />
      ) : (
        <p className="text-muted-foreground p-4">
          Create a text document to start its history.
        </p>
      )}
    </section>
  );
}

function DocumentVersions({ nodeId }: { nodeId: string }) {
  const { projectId, canWrite, collaboration } = useWorkspace();
  const file = collaboration.get(nodeId);
  const status = useSyncExternalStore(
    file?.subscribe ?? emptySubscribe,
    file?.getStatus ?? noStatus,
    noStatus,
  );
  const [page, setPage] =
    useState<Awaited<ReturnType<typeof listDocumentHistory>>>();
  const [selected, setSelected] = useState<DocumentVersion>();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const editable =
    canWrite && status?.connected && status.canWrite && status.ready;
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await listDocumentHistory({ data: { projectId, nodeId } });
      setPage(result);
      setSelected(
        (previous) =>
          result.versions.find((entry) => entry.id === previous?.id) ??
          result.versions[0],
      );
    } catch (error) {
      setError(message(error));
    } finally {
      setLoading(false);
    }
  }, [projectId, nodeId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function create() {
    if (!editable || !file || !label.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await file.save();
      const version = await createDocumentVersion({
        data: { projectId, nodeId, label: label.trim() },
      });
      setLabel("");
      await refresh();
      setSelected(version);
      setNotice("Named version saved.");
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    if (!page?.next) return;
    setBusy(true);
    setError("");
    try {
      const result = await listDocumentHistory({
        data: { projectId, nodeId, before: page.next },
      });
      setPage({
        versions: [...page.versions, ...result.versions],
        next: result.next,
      });
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="space-y-3 border-b p-3">
        <p className="text-muted-foreground text-xs">
          Text versions save after five minutes of activity and remain for{" "}
          {historyRetentionDays} days. Named versions stay until the project is
          deleted. File names, folders, and binary files are not versioned.
        </p>
        {canWrite && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
            className="flex flex-wrap gap-2"
          >
            <Input
              aria-label="New version name"
              placeholder="e.g. Before reviewer feedback"
              value={label}
              maxLength={100}
              onChange={(event) => setLabel(event.target.value)}
              className="min-w-36 flex-1"
              disabled={busy}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={!editable || busy || !label.trim()}
            >
              {busy ? "Saving…" : "Save named version"}
            </Button>
          </form>
        )}
        {canWrite && !editable && (
          <p role="status" className="text-muted-foreground text-xs">
            Connect to the document to save or restore versions.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive wrap-anywhere">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <h2 className="font-medium">Versions</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || loading}
          onClick={() => void refresh()}
        >
          <IconRefresh />
          Refresh
        </Button>
      </div>
      {loading && (
        <p role="status" className="text-muted-foreground px-3 pb-3">
          Loading versions…
        </p>
      )}
      {!loading && page?.versions.length === 0 && (
        <p className="text-muted-foreground px-3 pb-4">
          No versions yet. Your first edit preserves the starting text. Save a
          named version at any time.
        </p>
      )}
      {!!page?.versions.length && (
        <div
          className="max-h-52 shrink-0 overflow-auto border-b"
          aria-label="Saved versions"
        >
          <ul>
            {page.versions.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  aria-pressed={selected?.id === version.id}
                  disabled={busy}
                  onClick={() => {
                    setSelected(version);
                    setNotice("");
                  }}
                  className={`hover:bg-muted focus-visible:ring-ring block w-full px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-inset ${selected?.id === version.id ? "bg-muted" : ""}`}
                >
                  <span className="block truncate font-medium">
                    {versionName(version)}
                  </span>
                  <time
                    dateTime={new Date(version.createdAt).toISOString()}
                    className="text-muted-foreground text-xs tabular-nums"
                  >
                    {new Date(version.createdAt).toLocaleString()}
                  </time>
                  <span className="text-muted-foreground block truncate text-xs">
                    {version.authors.map((author) => author.name).join(", ") ||
                      "Starting document"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {page.next && (
            <Button
              variant="ghost"
              className="m-2"
              disabled={busy}
              onClick={() => void more()}
            >
              Load older versions
            </Button>
          )}
        </div>
      )}
      {selected && (
        <VersionComparison
          key={selected.id}
          nodeId={nodeId}
          version={selected}
          editable={!!editable}
          onChanged={async (notice) => {
            await refresh();
            setNotice(notice);
          }}
        />
      )}
    </div>
  );
}

function VersionComparison({
  nodeId,
  version,
  editable,
  onChanged,
}: {
  nodeId: string;
  version: DocumentVersion;
  editable: boolean;
  onChanged: (notice: string) => Promise<void>;
}) {
  const { projectId, collaboration } = useWorkspace();
  const file = collaboration.get(nodeId);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!file) return emptySubscribe();
      file.text.observe(listener);
      return () => file.text.unobserve(listener);
    },
    [file],
  );
  const readText = useCallback(() => file?.text.toString() ?? "", [file]);
  const liveText = useSyncExternalStore(subscribe, readText, noText);
  const status = useSyncExternalStore(
    file?.subscribe ?? emptySubscribe,
    file?.getStatus ?? noStatus,
    noStatus,
  );
  const [comparison, setComparison] =
    useState<Awaited<ReturnType<typeof compareDocumentHistory>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [label, setLabel] = useState(version.label ?? "");
  const load = useCallback(async () => {
    setError("");
    try {
      setComparison(
        await compareDocumentHistory({
          data: { projectId, nodeId, versionId: version.id },
        }),
      );
    } catch (error) {
      setError(message(error));
    }
  }, [projectId, nodeId, version.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const current = status?.ready ? liveText : (comparison?.current ?? "");
  const changes = useMemo(() => {
    if (!comparison || comparison.value.length + current.length > 200_000)
      return undefined;
    return diffLines(comparison.value, current, {
      timeout: 100,
      maxEditLength: 5000,
    });
  }, [comparison, current]);
  async function name() {
    if (!editable || !label.trim()) return;
    setBusy(true);
    setError("");
    try {
      await nameDocumentVersion({
        data: { projectId, nodeId, versionId: version.id, label: label.trim() },
      });
      await onChanged(
        "Version named. It will be kept until the project is deleted.",
      );
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (!editable || !file) return;
    setBusy(true);
    setError("");
    try {
      await file.save();
      await restoreDocumentVersion({
        data: { projectId, nodeId, versionId: version.id },
      });
      setConfirmRestore(false);
      await onChanged(
        "Version restored. The previous text was saved as a separate version.",
      );
      await load();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-h-0 space-y-3 p-3">
      <h3 className="font-medium">{versionName(version)} → Current text</h3>
      {error && (
        <p role="alert" className="text-destructive wrap-anywhere">
          {error}{" "}
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      )}
      {!comparison && !error && <p role="status">Loading comparison…</p>}
      {comparison && (
        <>
          <p className="text-muted-foreground text-xs">
            − Removed from this version · + Added in current text
          </p>
          {changes ? (
            <pre
              aria-label="Version diff"
              className="bg-muted/30 max-h-96 overflow-auto rounded-md border p-2 font-mono text-xs leading-5 [tab-size:2]"
            >
              {changes.map((change, index) => (
                <span
                  key={index}
                  className={`block wrap-anywhere whitespace-pre-wrap ${change.added ? "bg-emerald-500/15" : change.removed ? "bg-red-500/15" : "text-muted-foreground"}`}
                >
                  {change.value
                    .split("\n")
                    .slice(0, change.value.endsWith("\n") ? -1 : undefined)
                    .map(
                      (line) =>
                        `${change.added ? "+" : change.removed ? "−" : " "} ${line}`,
                    )
                    .join("\n")}
                </span>
              ))}
            </pre>
          ) : (
            <p className="text-muted-foreground">
              This comparison is too large to display. Download both versions to
              compare them locally.
            </p>
          )}
          {comparison.value === current && (
            <p className="text-muted-foreground">
              This version matches the current text.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                downloadFile(
                  new Blob([comparison.value], {
                    type: "text/plain;charset=utf-8",
                  }),
                  "document-version.txt",
                )
              }
            >
              <IconDownload />
              Download version
            </Button>
            {!changes && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  downloadFile(
                    new Blob([current], { type: "text/plain;charset=utf-8" }),
                    "document-current.txt",
                  )
                }
              >
                Download current text
              </Button>
            )}
          </div>
          {editable && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void name();
              }}
              className="flex flex-wrap gap-2"
            >
              <Input
                aria-label="Selected version name"
                value={label}
                maxLength={100}
                placeholder="Name this version"
                onChange={(event) => setLabel(event.target.value)}
                disabled={busy}
                className="min-w-36 flex-1"
              />
              <Button
                type="submit"
                variant="outline"
                disabled={busy || !label.trim()}
              >
                Name version
              </Button>
            </form>
          )}
          {editable &&
            (confirmRestore ? (
              <div className="space-y-2 rounded-md border p-3">
                <p>
                  Replace this document’s current text with this version?
                  Everyone editing will see the restored text. A copy of the
                  current text will be saved first.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={() => void restore()}>
                    {busy ? "Restoring…" : "Confirm restore"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirmRestore(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                disabled={busy || comparison.value === current}
                onClick={() => setConfirmRestore(true)}
              >
                Restore this version
              </Button>
            ))}
        </>
      )}
    </div>
  );
}
