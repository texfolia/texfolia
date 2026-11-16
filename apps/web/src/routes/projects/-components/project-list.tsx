import {
  IconFolderOpen,
  IconSearch,
  IconLayoutGrid,
  IconTemplate,
  IconLogout,
  IconPlus,
  IconSettings,
} from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
import { ClientOnly, Link } from "@tanstack/react-router";
import { useTable } from "@tanstack/react-table";
import { useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { Card } from "#/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "#/components/ui/input-group";
import { Kbd } from "#/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
} from "#/components/ui/sidebar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { authClient } from "#/lib/auth-client";
import { features } from "#/lib/features";
import { useProjects } from "#/providers/projects-provider";
import { useSettings } from "#/providers/settings-provider";
import { useAppShortcut } from "#/providers/shortcuts-provider";

import { GitImport } from "./git-import";
import { columns } from "./project-columns";
import { ProjectForm } from "./project-form";

function SearchShortcut() {
  const { shortcuts } = useSettings();
  return <Kbd>{shortcuts.search}</Kbd>;
}

export function ProjectList() {
  const [query, setQuery] = useState("");
  const [signOutError, setSignOutError] = useState("");
  const [creating, setCreating] = useState(false);
  const store = useProjects();
  const { data: projects } = useLiveQuery(store.projects);
  const search = useRef<HTMLInputElement>(null);
  useAppShortcut("search", () => {
    search.current?.focus();
    search.current?.select();
  });
  useAppShortcut("newProject", () => setCreating(true));

  const table = useTable({
    key: "projects",
    features,
    columns,
    data: projects.filter((project) =>
      project.name.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  });

  return (
    <Dialog open={creating} onOpenChange={setCreating}>
      <Sidebar>
        <SidebarHeader className="h-20 justify-center px-6">
          <SidebarMenu>
            <SidebarMenuItem>
              <Link to="/" className="font-serif text-3xl tracking-tight">
                Texfolia.
              </Link>
            </SidebarMenuItem>
          </SidebarMenu>
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
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link to="/templates" search={{ page: 0 }} />}
                >
                  <IconTemplate />
                  Templates
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link to="/settings/billing" />}>
                Billing
              </SidebarMenuButton>
              <SidebarMenuButton render={<Link to="/settings" />}>
                <IconSettings />
                Settings
              </SidebarMenuButton>
              <SidebarMenuButton
                onClick={async () => {
                  try {
                    const result = await authClient.signOut();
                    if (result.error) throw new Error();
                    window.location.assign("/");
                  } catch {
                    setSignOutError("Could not sign out. Try again.");
                  }
                }}
              >
                <IconLogout />
                Sign out
              </SidebarMenuButton>
              {signOutError && (
                <p role="alert" className="text-destructive p-2 text-xs">
                  {signOutError}
                </p>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <div
          id="main-content"
          className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-10 sm:py-12"
        >
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <div className="flex-1">
              <h1 className="text-3xl font-semibold tracking-tight">
                Projects
              </h1>
              <p className="text-muted-foreground mt-2 hidden text-sm sm:block">
                Your papers, ideas, and works in progress.
              </p>
            </div>
            <Link
              to="/templates"
              search={{ page: 0 }}
              className="hidden text-sm underline underline-offset-4 sm:inline"
            >
              Templates
            </Link>
            <DialogTrigger render={<Button size="lg" />}>
              <IconPlus />
              New project
            </DialogTrigger>
          </div>
          <GitImport />
          <InputGroup className="max-w-sm">
            <InputGroupInput
              ref={search}
              aria-label="Search projects"
              placeholder="Search projects..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <InputGroupAddon>
              <IconSearch />
            </InputGroupAddon>
            <InputGroupAddon align="inline-end">
              <ClientOnly fallback={<Kbd>Mod+K</Kbd>}>
                <SearchShortcut />
              </ClientOnly>
            </InputGroupAddon>
          </InputGroup>
          <Card className="gap-0 overflow-hidden py-0">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        <table.FlexRender header={header} />
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows?.length ? (
                  table.getRowModel().rows.map((row) => (
                    <TableRow
                      key={row.id}
                      data-state={row.getIsSelected() && "selected"}
                    >
                      {row.getAllCells().map((cell) => (
                        <TableCell key={cell.id}>
                          <table.FlexRender cell={cell} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Empty>
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <IconFolderOpen />
                          </EmptyMedia>
                          <EmptyTitle>
                            {projects.length
                              ? "No matching projects"
                              : "No projects yet"}
                          </EmptyTitle>
                          <EmptyDescription>
                            {projects.length
                              ? "Try another search, or create a project."
                              : "Create your first LaTeX workspace."}
                          </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                          <Button onClick={() => setCreating(true)}>
                            Create Project
                          </Button>
                        </EmptyContent>
                      </Empty>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      </SidebarInset>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Give your workspace a name. You can add files and share with
            existing Texfolia accounts inside.
          </DialogDescription>
        </DialogHeader>
        <ProjectForm />
        <DialogFooter>
          <DialogClose>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
