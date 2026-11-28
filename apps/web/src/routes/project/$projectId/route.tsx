import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { lazy } from "react";

import { LinkNoLongerWorks } from "#/components/link-no-longer-works";
import { openProject } from "#/lib/projects/project.functions";

// The project's one URL, for editors, commenters, viewers, anonymous guests
// with a view link, and people without access alike. Each shell is its own
// chunk, so guests never download the editor.
const loadMember = () => import("./-components/member-workspace");
const loadGuest = () => import("./-components/guest-workspace");
const MemberWorkspace = lazy(async () => ({
  default: (await loadMember()).MemberWorkspace,
}));
const GuestWorkspace = lazy(async () => ({
  default: (await loadGuest()).GuestWorkspace,
}));

export const Route = createFileRoute("/project/$projectId")({
  ssr: false,
  validateSearch: (
    search: Record<string, unknown>,
  ): { thread?: string; view?: "scratchpad" } => ({
    thread:
      typeof search.thread === "string" && search.thread
        ? search.thread
        : undefined,
    view: search.view === "scratchpad" ? "scratchpad" : undefined,
  }),
  loader: async ({ params, context, location }) => {
    // Start downloading the likely shell while the project loads.
    void (context.appUser ? loadMember() : loadGuest()).catch(() => {});
    const opened = await openProject({ data: { projectId: params.projectId } });
    if (opened.kind === "sign-in")
      throw redirect({
        to: "/login",
        search: { redirectTo: location.pathname },
      });
    if (opened.kind === "missing") throw notFound();
    if (opened.kind === "revoked") return opened;
    if (opened.kind === "guest") {
      await loadGuest();
      return opened;
    }
    const { project, userId } = opened;
    // Loaders are part of every page's first bundle; the store is not.
    const [{ createProjectFilesStore }] = await Promise.all([
      import("#/providers/project-files-provider"),
      loadMember(),
    ]);
    const files = createProjectFilesStore({
      initial: project.nodes,
      projectId: project.id,
      initialSourceVersions: project.sourceVersions,
      mainFile: project.mainFile,
      commentsVersion: project.commentsVersion,
      gitVersion: project.gitVersion,
    });
    await files.nodes.preload();
    return { kind: "workspace" as const, project, userId, files };
  },
  head: ({ loaderData }) => ({
    meta: [
      ...(loaderData?.kind === "workspace" || loaderData?.kind === "guest"
        ? [{ title: `${loaderData.project.name} | Texfolia` }]
        : []),
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  remountDeps: ({ params }) => params.projectId,
  notFoundComponent: ProjectNotFound,
  component: ProjectPage,
});

function ProjectPage() {
  const opened = Route.useLoaderData();
  const { thread, view } = Route.useSearch();
  if (opened.kind === "revoked") return <LinkNoLongerWorks />;
  if (opened.kind === "guest")
    return <GuestWorkspace project={opened.project} />;
  return (
    <MemberWorkspace
      project={opened.project}
      files={opened.files}
      userId={opened.userId}
      initialThread={thread}
      initialView={view}
    />
  );
}

function ProjectNotFound() {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-4 px-6"
    >
      <h1 className="text-2xl">Project not found</h1>
      <p className="text-muted-foreground">
        It may have been deleted, or you don’t have access. Ask its owner to
        share it with you, or open the link they sent you.
      </p>
      <Link to="/projects" className="underline">
        Go to your projects
      </Link>
    </main>
  );
}
