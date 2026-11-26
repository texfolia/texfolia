import { IconEye, IconFile, IconFileText } from "@tabler/icons-react";
import { type BuildSnapshot } from "@texfolia/contracts";
import { cn } from "cn";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { BinaryPreview } from "#/components/binary-preview";
import { lazyPanel } from "#/components/lazy-panel";
import { PanelHeader } from "#/components/panel-header";
import { ProjectBuildEvents } from "#/lib/compile";
import { buildFileUrl } from "#/lib/compile/build";
import { projectMainFile, projectPaths } from "#/lib/projects";
import type { GuestProject } from "#/lib/projects/project.functions";
import { imageType } from "#/lib/storage/preview";
import { ThemeProvider } from "#/providers/theme-provider";

const PdfViewer = lazy(() => import("./pdf"));

// The source viewer loads the collaboration client only when a text file opens.
const GuestText = lazyPanel("The source", async () => {
  const { GuestText } = await import("./guest-text");
  return GuestText;
});

export type GuestNode = GuestProject["nodes"][number];

function sourceUrl(projectId: string, nodeId: string) {
  return `/api/sources/${projectId}/${nodeId}`;
}

// The view-only page for anonymous share-link guests: files, read-only sources
// that follow live edits, and the latest PDF. No comments, scratchpad, or
// assistant, which need an account. The share cookie authenticates requests.
export function GuestWorkspace({ project }: { project: GuestProject }) {
  return (
    // Guests have no account settings; appearance stays in this browser.
    <ThemeProvider userId="share-guest">
      <GuestView project={project} />
    </ThemeProvider>
  );
}

function GuestView({ project }: { project: GuestProject }) {
  const files = useMemo(() => {
    const paths = projectPaths(project.nodes);
    return project.nodes
      .filter((node) => node.kind !== "folder")
      .map((node) => ({ node, path: paths.get(node.id) ?? node.name }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [project.nodes]);
  const [selected, setSelected] = useState<string | null>(() => {
    const main = projectMainFile(
      new Map(files.map(({ node, path }) => [node.id, path])),
      project.mainFile,
    );
    return main?.id ?? files[0]?.node.id ?? null;
  });
  const current = files.find(({ node }) => node.id === selected);

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
          View only
        </span>
        <a
          href={`/login?${new URLSearchParams({ redirectTo: `/project/${project.projectId}` })}`}
          className="shrink-0 text-xs underline"
        >
          Sign in
        </a>
      </header>
      <main
        id="main-content"
        className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(16rem,1fr)_minmax(20rem,1fr)] overflow-y-auto lg:grid-cols-[14rem_minmax(0,1fr)_minmax(0,1fr)] lg:grid-rows-1 lg:overflow-hidden"
      >
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
                      aria-current={node.id === selected ? "true" : undefined}
                      onClick={() => setSelected(node.id)}
                      className={cn(
                        "hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-1.5 px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset",
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
            <GuestSource
              key={current.node.id}
              projectId={project.projectId}
              node={current.node}
              path={current.path}
            />
          ) : (
            <p className="text-muted-foreground p-3 text-sm">
              Select a file to view it.
            </p>
          )}
        </section>
        <section aria-label="PDF" className="flex min-h-0 flex-col">
          <GuestPdf projectId={project.projectId} />
        </section>
      </main>
    </div>
  );
}

function GuestSource({
  projectId,
  node,
  path,
}: {
  projectId: string;
  node: GuestNode;
  path: string;
}) {
  const url = sourceUrl(projectId, node.id);
  return (
    <>
      <PanelHeader title={path}>{null}</PanelHeader>
      {node.kind === "text" && !imageType(node.name) ? (
        <GuestText projectId={projectId} node={node} />
      ) : (
        <BinaryPreview
          url={url}
          name={node.name}
          fallback={
            <p className="p-3 text-sm">
              This file can’t be previewed.{" "}
              <a href={url} download={node.name} className="underline">
                Download {node.name}
              </a>
            </p>
          }
        />
      )}
    </>
  );
}

function GuestPdf({ projectId }: { projectId: string }) {
  const [snapshot, setSnapshot] = useState<BuildSnapshot | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  useEffect(() => {
    const events = new ProjectBuildEvents(projectId, setSnapshot);
    const unsubscribe = events.subscribe((event) =>
      setDisconnected(event.kind === "disconnected"),
    );
    return () => {
      unsubscribe();
      events.close();
    };
  }, [projectId]);
  const artifacts = snapshot?.artifacts;
  const pdf = artifacts?.files.find((file) => file.path === artifacts.pdf);
  const url = pdf ? buildFileUrl(projectId, pdf) : null;
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
