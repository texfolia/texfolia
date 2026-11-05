import { createFileRoute, Link } from "@tanstack/react-router";
import { useTable } from "@tanstack/react-table";
import { FolderOpenIcon, Search, Settings } from "lucide-react";

import { ProjectForm } from "#/components/project-form";
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
  SidebarProvider,
} from "#/components/ui/sidebar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { columns } from "#/lib/columns";
import { features } from "#/lib/features";
import { getProjects } from "#/lib/projects.functions";

export const Route = createFileRoute("/projects/")({
  head: () => ({
    meta: [
      {
        title: "Your Projects | Texfolia",
      },
    ],
  }),
  loader: async () => {
    return { projects: await getProjects() };
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { projects } = Route.useLoaderData();

  const table = useTable({
    key: "projects",
    features,
    columns,
    data: projects,
  });

  return (
    <SidebarProvider>
      <Sidebar variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <Link to="/">Texfolia</Link>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup></SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <Button variant="outline" className="w-full">
                <Settings />
                Settings
              </Button>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <main className="flex flex-col gap-4 p-4">
          <h1>Projects</h1>
          <InputGroup className="max-w-sm">
            <InputGroupInput
              placeholder="Search projects..."
              value={table.state.globalFilter || ""}
              onChange={(e) => table.setGlobalFilter(e.target.value)}
            />
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupAddon align="inline-end">
              <Kbd>&#x2318;K</Kbd>
            </InputGroupAddon>
          </InputGroup>
          <Card>
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
                            <FolderOpenIcon />
                          </EmptyMedia>
                          <EmptyTitle>No Projects Yet</EmptyTitle>
                          <EmptyDescription>No data found</EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                          <Dialog>
                            <DialogTrigger render={<Button />}>
                              Create Project
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>New Project</DialogTitle>
                                <DialogDescription>
                                  Create a LaTeX workspace.
                                </DialogDescription>
                              </DialogHeader>
                              <ProjectForm />
                              <DialogFooter>
                                <DialogClose>Close</DialogClose>
                              </DialogFooter>
                            </DialogContent>
                          </Dialog>
                        </EmptyContent>
                      </Empty>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
