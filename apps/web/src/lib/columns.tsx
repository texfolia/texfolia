import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Copy, Download, Edit, UserPlus } from "lucide-react";

import { DeleteProjectButton } from "#/components/delete-project-button";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { ButtonGroup } from "#/components/ui/button-group";
import { Checkbox } from "#/components/ui/checkbox";

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
  columnHelper.accessor("collaborators", {
    header: "Collaborators",
    cell: () => (
      <AvatarGroup>
        <Avatar>
          <AvatarImage
            alt="Frida Kahlo"
            src="https://images.unsplash.com/photo-1543610892-0b1f7e6d8ac1?w=96&h=96&dpr=2&q=80"
          />
          <AvatarFallback>FK</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarImage
            alt="Nadia Ekman"
            src="https://images.unsplash.com/photo-1628157588553-5eeea00af15c?w=96&h=96&dpr=2&q=80"
          />
          <AvatarFallback>NE</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarImage
            alt="Eli Wren"
            src="https://images.unsplash.com/photo-1655874819398-c6dfbec68ac7?w=96&h=96&dpr=2&q=80"
          />
          <AvatarFallback>EW</AvatarFallback>
        </Avatar>
        <AvatarGroupCount>+2</AvatarGroupCount>
      </AvatarGroup>
    ),
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
      <ButtonGroup>
        <Button size="icon-lg" variant="outline">
          <Copy />
        </Button>
        <Button size="icon-lg" variant="outline">
          <Download />
        </Button>
        <Button size="icon-lg" variant="outline">
          <UserPlus />
        </Button>
        <Button size="icon-lg" variant="outline">
          <Edit />
        </Button>
        <DeleteProjectButton project={row.original} />
      </ButtonGroup>
    ),
  }),
]);
