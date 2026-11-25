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
import type { getSharedProject } from "#/lib/sharing/project-share-links.functions";
import { withShareToken } from "#/lib/sharing/share-token";
import { imageType } from "#/lib/storage/preview";

const PdfViewer = lazy(
  () => import("#/routes/project/$projectId/-components/pdf"),
);

// PDF-only links load neither the editor nor the collaboration client.
const SharedText = lazyPanel("The source", async () => {
  const { SharedText } = await import("./shared-text");
  return SharedText;
});

type SharedProject = NonNullable<Awaited<ReturnType<typeof getSharedProject>>>;
export type SharedNode = SharedProject["nodes"][number];

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
    const main = projectMainFile(
      new Map(files.map(({ node, path }) => [node.id, path])),
      project.mainFile,
    );
    return main?.id ?? files[0]?.node.id ?? null;
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
  const url = sourceUrl(projectId, node.id, token);
  return (
    <>
      <PanelHeader title={path}>{null}</PanelHeader>
      {node.kind === "text" && !imageType(node.name) ? (
        <SharedText projectId={projectId} node={node} token={token} />
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
