import { createFileRoute } from "@tanstack/react-router";
import { useTable } from "@tanstack/react-table";
import { FolderOpenIcon } from "lucide-react";

import { ProjectForm } from "#/components/project-form";
import { Button } from "#/components/ui/button";
import { CardFrame } from "#/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
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
  Sidebar,
  SidebarContent,
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
            <SidebarMenuItem>Texfolia</SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent></SidebarContent>
      </Sidebar>
      <SidebarInset>
        <main className="flex flex-col gap-4 p-4">
          <h1>Your Projects</h1>
          <CardFrame>
            <Table variant="card">
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
                            <DialogPopup>
                              <DialogHeader>
                                <DialogTitle>New Project</DialogTitle>
                                <DialogDescription>
                                  Dialog Description
                                </DialogDescription>
                              </DialogHeader>
                              <DialogPanel>
                                <ProjectForm />
                              </DialogPanel>
                              <DialogFooter>
                                <DialogClose>Close</DialogClose>
                              </DialogFooter>
                            </DialogPopup>
                          </Dialog>
                        </EmptyContent>
                      </Empty>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardFrame>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
