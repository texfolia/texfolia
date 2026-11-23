import { markdown } from "@codemirror/lang-markdown";
import { IconEye, IconFile, IconFileText } from "@tabler/icons-react";
import { ProjectBuildEvents } from "@texfolia/compile";
import { type BuildSnapshot } from "@texfolia/contracts";
import { bibtexLanguage, themedLatex } from "@texfolia/editor/latex/highlight";
import CodeMirror, { EditorState } from "@uiw/react-codemirror";
import { cn } from "cn";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { PanelHeader } from "#/components/panel-header";
import { buildFileUrl } from "#/lib/build";
import { CollaborativeFile } from "#/lib/collaboration/file";
import { projectPaths } from "#/lib/project-paths";
import type { getSharedProject } from "#/lib/project-share-links.functions";
import { withShareToken } from "#/lib/project-share-links.schema";
import { useTheme } from "#/providers/theme-provider";

const PdfViewer = lazy(
  () => import("#/routes/project/$projectId/-components/pdf"),
);

type SharedProject = NonNullable<Awaited<ReturnType<typeof getSharedProject>>>;
type SharedNode = SharedProject["nodes"][number];

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
};

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function sourceUrl(projectId: string, nodeId: string, token: string) {
  return withShareToken(`/api/sources/${projectId}/${nodeId}`, token);
}

export function SharedProjectView({
  project,
  token,
}: {
  project: SharedProject;
  token: string;
}) {
  const files = useMemo(() => {
    const paths = projectPaths(project.nodes);
    return project.nodes
      .filter((node) => node.kind !== "folder")
      .map((node) => ({ node, path: paths.get(node.id) ?? node.name }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [project.nodes]);
  const [selected, setSelected] = useState<string | null>(() => {
    const main =
      files.find(({ path }) => path === "main.tex") ??
      files.find(({ path }) => path.endsWith(".tex")) ??
      files[0];
    return main?.node.id ?? null;
  });
  const current = files.find(({ node }) => node.id === selected);
  const pdfOnly = project.scope === "pdf";

  return (
    <div className="bg-background text-foreground flex h-svh flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <a href="/" className="font-medium">
          Texfolia
        </a>
        <span aria-hidden className="text-muted-foreground">
          /
        </span>
        <h1 className="min-w-0 flex-1 truncate" title={project.name}>
          {project.name}
        </h1>
        <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
          <IconEye className="size-3.5" aria-hidden />
          {pdfOnly ? "View PDF only" : "View only"}
        </span>
      </header>
      <main
        id="main-content"
        className={cn(
          "grid min-h-0 flex-1 grid-cols-1",
          pdfOnly
            ? ""
            : "grid-rows-[auto_minmax(16rem,1fr)_minmax(20rem,1fr)] overflow-y-auto lg:grid-cols-[14rem_minmax(0,1fr)_minmax(0,1fr)] lg:grid-rows-1 lg:overflow-hidden",
        )}
      >
        {!pdfOnly && (
          <>
            <nav
              aria-label="Project files"
              className="max-h-48 overflow-y-auto border-b text-xs lg:max-h-none lg:border-r lg:border-b-0"
            >
              <PanelHeader title="Files">{null}</PanelHeader>
              {files.length === 0 ? (
                <p className="text-muted-foreground p-2">No files.</p>
              ) : (
                <ul className="py-1">
                  {files.map(({ node, path }) => {
                    const Icon = node.kind === "text" ? IconFileText : IconFile;
                    return (
                      <li key={node.id}>
                        <button
                          type="button"
                          aria-current={
                            node.id === selected ? "true" : undefined
                          }
                          onClick={() => setSelected(node.id)}
                          className={cn(
                            "hover:bg-accent flex w-full items-center gap-1.5 px-2 py-1 text-left",
                            node.id === selected &&
                              "bg-accent text-accent-foreground",
                          )}
                        >
                          <Icon className="size-3.5 shrink-0" aria-hidden />
                          <span className="truncate" title={path}>
                            {path}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </nav>
            <section
              aria-label="Source"
              className="flex min-h-0 flex-col border-b lg:border-r lg:border-b-0"
            >
              {current ? (
                <SharedSource
                  key={current.node.id}
                  projectId={project.projectId}
                  node={current.node}
                  path={current.path}
                  token={token}
                />
              ) : (
                <p className="text-muted-foreground p-3 text-sm">
                  Select a file to view it.
                </p>
              )}
            </section>
          </>
        )}
        <section aria-label="PDF" className="flex min-h-0 flex-col">
          <SharedPdf projectId={project.projectId} token={token} />
        </section>
      </main>
    </div>
  );
}

function SharedSource({
  projectId,
  node,
  path,
  token,
}: {
  projectId: string;
  node: SharedNode;
  path: string;
  token: string;
}) {
  return (
    <>
      <PanelHeader title={path}>{null}</PanelHeader>
      {node.kind === "text" ? (
        <SharedText projectId={projectId} node={node} token={token} />
      ) : (
        <SharedBinary projectId={projectId} node={node} token={token} />
      )}
    </>
  );
}

function SharedText({
  projectId,
  node,
  token,
}: {
  projectId: string;
  node: SharedNode;
  token: string;
}) {
  const { theme } = useTheme();
  const [value, setValue] = useState("");
  // Follow live edits through the collaboration room, read-only.
  const [file] = useState(
    () =>
      new CollaborativeFile({
        projectId,
        nodeId: node.id,
        userId: "share-guest",
        canWrite: false,
        shareToken: token,
        onChange: setValue,
      }),
  );
  useEffect(() => () => file.destroy(), [file]);
  const status = useSyncExternalStore(file.subscribe, file.getStatus);
  const extensions = useMemo(() => {
    const extension = extensionOf(node.name);
    const language = ["tex", "ltx", "sty", "cls"].includes(extension)
      ? [themedLatex(node.name)]
      : extension === "md"
        ? [markdown()]
        : extension === "bib"
          ? [bibtexLanguage]
          : [];
    return [EditorState.readOnly.of(true), ...language];
  }, [node.name]);
  if (!status.ready)
    return (
      <p
        role={status.error ? "alert" : "status"}
        className={cn("p-3 text-sm", status.error && "text-destructive")}
      >
        {status.error || "Loading source…"}
      </p>
    );
  return (
    <>
      {status.error && (
        <p role="alert" className="text-destructive border-b px-2 py-1 text-xs">
          {status.error}
        </p>
      )}
      <CodeMirror
        value={value}
        extensions={extensions}
        readOnly
        height="100%"
        theme={theme.extension}
        aria-label={`${node.name} source, read only`}
        className="min-h-0 flex-1 overflow-hidden [&>.cm-editor]:h-full"
      />
    </>
  );
}

function SharedBinary({
  projectId,
  node,
  token,
}: {
  projectId: string;
  node: SharedNode;
  token: string;
}) {
  const extension = extensionOf(node.name);
  const url = sourceUrl(projectId, node.id, token);
  const [file, setFile] = useState<File>();
  const [error, setError] = useState("");
  const previewType =
    imageTypes[extension] ?? (extension === "pdf" ? "application/pdf" : null);
  useEffect(() => {
    if (!previewType) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok) throw new Error("Could not open this file.");
        const blob = await response.blob();
        if (!abort.signal.aborted)
          setFile(new File([blob], node.name, { type: previewType }));
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not open this file.",
          );
      }
    })();
    return () => abort.abort();
  }, [url, node.name, previewType]);
  const objectUrl = useMemo(
    () =>
      file && previewType?.startsWith("image/")
        ? URL.createObjectURL(file)
        : null,
    [file, previewType],
  );
  useEffect(
    () => () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
    [objectUrl],
  );
  if (!previewType)
    return (
      <p className="p-3 text-sm">
        This file can’t be previewed.{" "}
        <a href={url} download={node.name} className="underline">
          Download {node.name}
        </a>
      </p>
    );
  if (error)
    return (
      <p role="alert" className="text-destructive p-3 text-sm">
        {error}
      </p>
    );
  if (!file)
    return (
      <p role="status" className="p-3 text-sm">
        Loading file…
      </p>
    );
  if (objectUrl)
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <img src={objectUrl} alt={node.name} className="max-w-full" />
      </div>
    );
  return (
    <Suspense fallback={<p className="p-3 text-sm">Loading PDF viewer…</p>}>
      <PdfViewer file={file} filename={node.name} />
    </Suspense>
  );
}

function SharedPdf({ projectId, token }: { projectId: string; token: string }) {
  const [snapshot, setSnapshot] = useState<BuildSnapshot | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  useEffect(() => {
    const events = new ProjectBuildEvents(projectId, setSnapshot, (url) =>
      withShareToken(url, token),
    );
    const unsubscribe = events.subscribe((event) =>
      setDisconnected(event.kind === "disconnected"),
    );
    return () => {
      unsubscribe();
      events.close();
    };
  }, [projectId, token]);
  const artifacts = snapshot?.artifacts;
  const pdf = artifacts?.files.find((file) => file.path === artifacts.pdf);
  const url = pdf ? buildFileUrl(projectId, pdf, token) : null;
  const notice = disconnected
    ? "Live updates are paused. Reconnecting…"
    : snapshot?.current &&
        ["queued", "running"].includes(snapshot.current.status)
      ? "A new build is in progress."
      : "";
  return (
    <>
      {notice && (
        <p
          role="status"
          className="text-muted-foreground shrink-0 border-b px-2 py-1 text-xs"
        >
          {notice}
        </p>
      )}
      {url ? (
        <Suspense fallback={<p className="p-3 text-sm">Loading PDF viewer…</p>}>
          <PdfViewer
            file={url}
            filename={pdf?.path.split("/").pop() || "document.pdf"}
          />
        </Suspense>
      ) : (
        <p role="status" className="text-muted-foreground p-3 text-sm">
          {snapshot ? "No PDF has been built yet." : "Loading PDF…"}
        </p>
      )}
    </>
  );
}
