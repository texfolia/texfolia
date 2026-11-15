import { IconArrowUpRight, IconFileText } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";

import { buttonVariants } from "#/components/ui/button";
import type { Features } from "#/lib/features";
import type { Project } from "#/lib/project.functions";
import { useProjects } from "#/providers/projects-provider";

import { DeleteProjectButton } from "./delete-project-button";

const columnHelper = createColumnHelper<Features, Project>();

function ProjectActions({ project }: { project: Project }) {
  const { ownerId } = useProjects();
  return (
    <div className="flex items-center justify-end gap-1">
      <Link
        to="/project/$projectId"
        params={{ projectId: project.id }}
        aria-label={`Open ${project.name}`}
        className={buttonVariants({ variant: "ghost", size: "icon" })}
      >
        <IconArrowUpRight />
      </Link>
      {project.ownerId === ownerId && <DeleteProjectButton project={project} />}
    </div>
  );
}

export const columns = columnHelper.columns([
  columnHelper.accessor("name", {
    header: "Project",
    cell: ({ getValue, row }) => (
      <Link
        to="/project/$projectId"
        params={{ projectId: row.original.id }}
        className="flex min-w-40 items-center gap-3 py-3 font-medium underline-offset-4 hover:underline focus-visible:outline-2"
      >
        <IconFileText className="text-muted-foreground size-5 shrink-0" />
        <span className="max-w-[min(40vw,28rem)] truncate">{getValue()}</span>
      </Link>
    ),
  }),
  columnHelper.accessor("collaborators", {
    header: "Access",
    cell: ({ getValue, row }) => {
      const people = getValue();
      return (
        <span
          className="text-muted-foreground text-sm"
          title={people
            .map(
              (person) =>
                `${person.user?.name ?? "Collaborator"} (${person.role})`,
            )
            .join(", ")}
        >
          {row.original.organizationId
            ? "Organization"
            : people.length
              ? `${people.length} collaborator${people.length === 1 ? "" : "s"}`
              : "Personal"}
        </span>
      );
    },
  }),
  columnHelper.accessor("updatedAt", {
    header: "Last updated",
    enableSorting: true,
    cell: ({ getValue }) => (
      <time
        dateTime={getValue().toISOString()}
        className="text-muted-foreground text-sm tabular-nums"
      >
        {getValue().toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </time>
    ),
  }),
  columnHelper.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => <ProjectActions project={row.original} />,
  }),
]);
