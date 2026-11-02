import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Copy, Download, Edit, Trash, UserPlus } from "lucide-react";

import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Group, GroupSeparator } from "#/components/ui/group";

import type { Features } from "./features";
import type { GetProjectsResult } from "./projects.functions";

const columnHelper = createColumnHelper<Features, GetProjectsResult[number]>();

export const columns = columnHelper.columns([
  columnHelper.display({
    id: "checkbox",
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={() => row.toggleSelected()}
      />
    ),
  }),
  columnHelper.accessor("name", {
    header: "Name",
    cell: ({ getValue, row }) => (
      <Link to="/projects/$projectId" params={{ projectId: row.original.id }}>
        {getValue()}
      </Link>
    ),
  }),
  columnHelper.accessor("ownerId", {
    header: "Collaborators",
  }),
  columnHelper.accessor("updatedAt", {
    header: "Updated At",
    enableSorting: true,
    cell: ({ getValue }) => getValue().toLocaleDateString(),
  }),
  columnHelper.display({
    id: "actions",
    header: "Actions",
    cell: ({ row }) => (
      <Group>
        <Button size="icon-lg" variant="outline">
          <Copy />
        </Button>
        <GroupSeparator />
        <Button size="icon-lg" variant="outline">
          <Download />
        </Button>
        <GroupSeparator />
        <Button size="icon-lg" variant="outline">
          <UserPlus />
        </Button>
        <GroupSeparator />
        <Button size="icon-lg" variant="outline">
          <Edit />
        </Button>
        <GroupSeparator />
        <Button size="icon-lg" variant="outline">
          <Trash />
        </Button>
      </Group>
    ),
  }),
]);
