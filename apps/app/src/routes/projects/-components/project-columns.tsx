import { IconFileText } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  filterFn_arrIncludes,
} from "@tanstack/react-table";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@texfolia/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@texfolia/ui/tooltip";

import type { Project } from "#/features/projects/project.functions";

import { ProjectActions } from "./project-actions";
import type { Features } from "./project-table-features";

const columnHelper = createColumnHelper<Features, Project>();
export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
export const columns = columnHelper.columns([
  columnHelper.accessor("name", {
    header: "Project",
    enableSorting: true,
    sortFn: "alphanumeric",
    filterFn: "includesString",
    cell: ({ getValue, row }) => (
      <Link
        aria-label={getValue()}
        to="/project/$projectId"
        params={{ projectId: row.original.id }}
        className="group flex min-w-48 items-center gap-3 py-3 underline-offset-4 focus-visible:outline-2"
      >
        <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
          <IconFileText className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block max-w-[min(50vw,26rem)] truncate font-medium group-hover:underline">
            {getValue()}
          </span>
          <span className="text-muted-foreground mt-0.5 block text-xs">
            {row.original.organizationId
              ? "Organization project"
              : (row.original.owner?.name ?? "Personal project")}
          </span>
        </span>
      </Link>
    ),
  }),
  columnHelper.accessor((row) => row.people.length, {
    id: "collaborators",
    header: "Collaborators",
    enableSorting: true,
    sortFn: "basic",
    enableColumnFilter: false,
    cell: ({ row }) => (
      <AvatarGroup
        aria-label={
          row.original.people
            .map((person) => `${person.name} (${person.role})`)
            .join(", ") || "Organization members"
        }
      >
        {row.original.people.slice(0, 4).map((person) => (
          <Tooltip key={person.id}>
            <TooltipTrigger
              render={<span tabIndex={0} />}
              aria-label={`${person.name} (${person.role})`}
            >
              <Avatar size="sm" className="ring-background ring-2">
                {person.image && <AvatarImage src={person.image} alt="" />}
                <AvatarFallback>{initials(person.name)}</AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent>
              {person.name} · {person.role}
            </TooltipContent>
          </Tooltip>
        ))}
        {row.original.people.length > 4 && (
          <AvatarGroupCount>+{row.original.people.length - 4}</AvatarGroupCount>
        )}
      </AvatarGroup>
    ),
  }),
  columnHelper.accessor("tags", {
    header: "Your tags",
    enableSorting: true,
    sortFn: (a, b) =>
      a.original.tags.join(",").localeCompare(b.original.tags.join(",")),
    filterFn: filterFn_arrIncludes,
    cell: ({ getValue }) => (
      <div className="flex max-w-64 min-w-32 flex-wrap gap-1">
        {getValue().length ? (
          getValue().map((tag) => (
            <span
              key={tag}
              className="bg-muted text-muted-foreground max-w-40 truncate rounded-md px-2 py-1 text-xs"
              title={tag}
            >
              {tag}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground text-xs">No tags</span>
        )}
      </div>
    ),
  }),
  columnHelper.accessor("updatedAt", {
    header: "Updated",
    enableSorting: true,
    sortFn: "datetime",
    enableColumnFilter: false,
    cell: ({ getValue }) => (
      <time
        dateTime={getValue().toISOString()}
        title={getValue().toLocaleString()}
        className="text-muted-foreground text-sm whitespace-nowrap tabular-nums"
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
