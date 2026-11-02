import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Copy, Download, Edit, Trash, UserPlus } from "lucide-react";

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "#/components/ui/avatar";
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
  columnHelper.accessor("collaborators", {
    header: "Collaborators",
    cell: ({ cell }) => (
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
    cell: () => (
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
