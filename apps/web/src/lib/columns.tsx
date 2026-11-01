import { createColumnHelper } from "@tanstack/react-table";
import type { SelectProject } from "@texfolia/db";

import { Checkbox } from "#/components/ui/checkbox";

import type { Features } from "./features";

const columnHelper = createColumnHelper<Features, SelectProject>();

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
]);
