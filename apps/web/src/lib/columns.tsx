import { createColumnHelper } from "@tanstack/react-table";
import { Copy } from "lucide-react";

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
    header: "Project",
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
        <Button size="icon-lg">
          <Copy />
        </Button>
        <GroupSeparator />
        <Button>Button</Button>
      </Group>
    ),
  }),
]);
