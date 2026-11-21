import {
  IconArrowDown,
  IconArrowsSort,
  IconArrowUp,
  IconFileText,
  IconFolderOpen,
  IconLayoutGrid,
  IconPlus,
  IconSearch,
  IconSettings,
} from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import { useTable } from "@tanstack/react-table";
import { Button } from "@texfolia/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@texfolia/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@texfolia/ui/input-group";
import { Kbd } from "@texfolia/ui/kbd";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@texfolia/ui/sidebar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@texfolia/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@texfolia/ui/tooltip";
import { useEffect, useRef, useState } from "react";

import { features } from "#/lib/features";
import {
  useProjects,
  useProjectsPagination,
} from "#/providers/projects-provider";
import { useSettings } from "#/providers/settings-provider";
import { useAppShortcut } from "#/providers/shortcuts-provider";

import { NewProjectDialog } from "./new-project-dialog";
import { ProjectAccountMenu } from "./project-account-menu";
import { columns } from "./project-columns";

export function ProjectList({
  user,
}: {
  user: { id: string; name: string; email: string; image?: string | null };
}) {
  const [creating, setCreating] = useState(false);
  const store = useProjects();
  const { data: projects } = useLiveQuery(store.projects);
  const pagination = useProjectsPagination();
  const { shortcuts } = useSettings();
  const search = useRef<HTMLInputElement>(null);
  useAppShortcut("search", () => {
    search.current?.focus();
    search.current?.select();
  });
  useAppShortcut("newProject", () => setCreating(true));
  useEffect(() => {
    if (sessionStorage.getItem("texfolia.git.import")) setCreating(true);
  }, []);
  const table = useTable({
    key: "projects",
    features,
    columns,
    data: projects,
    initialState: { sorting: [{ id: "updatedAt", desc: true }] },
  });
  const nameFilter = table.getColumn("name");
  const tagFilter = table.getColumn("tags");
  const query = nameFilter?.getFilterValue();
  const tagValue = tagFilter?.getFilterValue();
  const selectedTag =
    Array.isArray(tagValue) && typeof tagValue[0] === "string"
      ? tagValue[0]
      : "";
  const recent = [...projects]
    .sort(
      (a, b) =>
        b.updatedAt.getTime() - a.updatedAt.getTime() ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 6);
  const tags = [...new Set(projects.flatMap((project) => project.tags))].sort();
  return (
    <>
      <Sidebar variant="inset">
        <SidebarHeader className="px-4 py-5">
          <Link
            to="/projects"
            className="px-2 text-xl font-semibold tracking-tight"
          >
            Texfolia<span className="text-muted-foreground">.</span>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive render={<Link to="/projects" />}>
                  <IconLayoutGrid />
                  Projects
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel title="Most recently updated">
              Recent projects
            </SidebarGroupLabel>
            <SidebarMenu>
              {recent.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton
                    render={
                      <Link
                        to="/project/$projectId"
                        params={{ projectId: project.id }}
                      />
                    }
                    tooltip={project.name}
                  >
                    <IconFileText />
                    <span>{project.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            {!recent.length && (
              <p className="text-muted-foreground px-2 py-2 text-xs">
                Your projects will appear here.
              </p>
            )}
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link to="/settings" />}>
                <IconSettings />
                Settings
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <ProjectAccountMenu user={user} />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
          <SidebarTrigger />
          <span className="text-muted-foreground text-sm">Workspace</span>
        </header>
        <div
          id="main-content"
          className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-7 px-4 py-7 sm:px-8 sm:py-9"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Projects
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                Your papers, ideas, and works in progress.
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={<Button onClick={() => setCreating(true)} />}
              >
                <IconPlus />
                New project
              </TooltipTrigger>
              <TooltipContent role="tooltip">
                New project{" "}
                <Kbd>{shortcuts.newProject.replaceAll(" ", " then ")}</Kbd>
              </TooltipContent>
            </Tooltip>
          </div>
          {projects.length === 0 ? (
            <Empty className="min-h-[55svh] border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <IconFolderOpen />
                </EmptyMedia>
                <EmptyTitle className="text-2xl">No projects yet</EmptyTitle>
                <EmptyDescription className="max-w-sm">
                  Make room for your next idea. Start with a blank document,
                  choose a template, or bring your existing work.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setCreating(true)}>
                  <IconPlus />
                  Create your first project
                </Button>
                <p className="text-muted-foreground text-xs">
                  Template, Git repository, or files and folders
                </p>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <InputGroup className="w-full sm:max-w-sm">
                  <InputGroupInput
                    ref={search}
                    aria-label="Search projects"
                    placeholder="Search projects…"
                    value={typeof query === "string" ? query : ""}
                    onChange={(event) =>
                      nameFilter?.setFilterValue(event.target.value)
                    }
                  />
                  <InputGroupAddon>
                    <IconSearch />
                  </InputGroupAddon>
                  <InputGroupAddon align="inline-end">
                    <Kbd>{shortcuts.search}</Kbd>
                  </InputGroupAddon>
                </InputGroup>
                <NativeSelect
                  aria-label="Filter by tag"
                  value={typeof selectedTag === "string" ? selectedTag : ""}
                  onChange={(event) =>
                    tagFilter?.setFilterValue(
                      event.target.value ? [event.target.value] : undefined,
                    )
                  }
                >
                  <NativeSelectOption value="">All tags</NativeSelectOption>
                  {tags.map((tag) => (
                    <NativeSelectOption key={tag} value={tag}>
                      {tag}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {Boolean(query || selectedTag) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => table.resetColumnFilters()}
                  >
                    Clear filters
                  </Button>
                )}
                <span
                  className="text-muted-foreground ml-auto text-xs tabular-nums"
                  role="status"
                >
                  {table.getRowModel().rows.length} of {projects.length}
                  {pagination.nextCursor ? "+" : ""} projects
                </span>
              </div>
              <div className="overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    {table.getHeaderGroups().map((group) => (
                      <TableRow key={group.id}>
                        {group.headers.map((header) => {
                          const sorted = header.column.getIsSorted();
                          return (
                            <TableHead
                              key={header.id}
                              aria-sort={
                                sorted === "asc"
                                  ? "ascending"
                                  : sorted === "desc"
                                    ? "descending"
                                    : undefined
                              }
                              className="bg-muted/40 px-4"
                            >
                              {header.column.getCanSort() ? (
                                <button
                                  type="button"
                                  className="hover:text-foreground focus-visible:ring-ring -mx-1 flex items-center gap-2 rounded px-1 py-3 text-xs font-medium outline-none focus-visible:ring-2"
                                  onClick={header.column.getToggleSortingHandler()}
                                >
                                  <table.FlexRender header={header} />
                                  {sorted === "asc" ? (
                                    <IconArrowUp className="size-3.5" />
                                  ) : sorted === "desc" ? (
                                    <IconArrowDown className="size-3.5" />
                                  ) : (
                                    <IconArrowsSort className="size-3.5 opacity-50" />
                                  )}
                                </button>
                              ) : (
                                <table.FlexRender header={header} />
                              )}
                            </TableHead>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody>
                    {table.getRowModel().rows.map((row) => (
                      <TableRow key={row.id}>
                        {row.getAllCells().map((cell) => (
                          <TableCell key={cell.id} className="px-4">
                            <table.FlexRender cell={cell} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                    {!table.getRowModel().rows.length && (
                      <TableRow>
                        <TableCell colSpan={columns.length}>
                          <Empty className="py-14">
                            <EmptyHeader>
                              <EmptyMedia variant="icon">
                                <IconSearch />
                              </EmptyMedia>
                              <EmptyTitle>No matching projects</EmptyTitle>
                              <EmptyDescription>
                                Try a different name or tag.
                              </EmptyDescription>
                            </EmptyHeader>
                            <EmptyContent>
                              <Button
                                variant="outline"
                                onClick={() => table.resetColumnFilters()}
                              >
                                Clear filters
                              </Button>
                            </EmptyContent>
                          </Empty>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {pagination.nextCursor && <LoadMoreSentinel />}
            </>
          )}
        </div>
      </SidebarInset>
      {creating && <NewProjectDialog open onOpenChange={setCreating} />}
    </>
  );
}

// Loads the next page as the end of the list nears the viewport. The observer
// is rebuilt after each page, and a new observer reports the current
// intersection at once, so a short (or filtered) list keeps filling until the
// sentinel scrolls out of view or the pages run out.
function LoadMoreSentinel() {
  const store = useProjects();
  const { loading, failed } = useProjectsPagination();
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || loading || failed) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void store.loadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [store, loading, failed]);
  return (
    <div
      ref={sentinel}
      className="text-muted-foreground flex min-h-10 items-center justify-center gap-2 text-sm"
      role="status"
    >
      {failed ? (
        <>
          Couldn’t load more projects.
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void store.loadMore()}
          >
            Try again
          </Button>
        </>
      ) : (
        loading && "Loading more projects…"
      )}
    </div>
  );
}
