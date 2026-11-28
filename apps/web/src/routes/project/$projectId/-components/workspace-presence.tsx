import { IconEye, IconEyeOff, IconUsers } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { scratchpadId, type Person } from "#/lib/collaboration";
import { useWorkspace } from "#/providers/workspace-provider";

type OnlinePerson = Person & { key: string };

function personKey(person: Pick<Person, "name" | "color">) {
  return `${person.name}:${person.color}`;
}

export function WorkspacePresence({
  paths,
  onOpenFile,
  onOpenScratchpad,
  onOpenCollaboration,
}: {
  paths: ReadonlyMap<string, string>;
  onOpenFile: (nodeId: string) => void;
  onOpenScratchpad: () => void;
  onOpenCollaboration: () => void;
}) {
  const { collaboration, scratchpad } = useWorkspace();
  const [people, setPeople] = useState<OnlinePerson[]>([]);
  const [followingKey, setFollowingKey] = useState<string | null>(null);
  const lastFollowedNodeId = useRef<string | undefined>(undefined);

  useEffect(() => {
    const documents = [
      ...collaboration.values(),
      ...(scratchpad ? [scratchpad] : []),
    ];
    const refresh = () => {
      const seen = new Map<string, OnlinePerson>();
      for (const file of documents)
        // The list covers the whole project, not only this file.
        for (const person of file.getStatus().people) {
          const key = personKey(person);
          const existing = seen.get(key);
          if (!existing || (!existing.nodeId && person.nodeId))
            seen.set(key, { ...person, key });
        }
      const next = [...seen.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      setPeople((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const unsubscribe = documents.map((file) => file.subscribe(refresh));
    refresh();
    return () => unsubscribe.forEach((stop) => stop());
  }, [collaboration, scratchpad]);

  const jumpTo = useCallback(
    (nodeId: string | undefined) => {
      if (!nodeId) return;
      if (nodeId === scratchpadId) onOpenScratchpad();
      else if (paths.has(nodeId)) onOpenFile(nodeId);
    },
    [onOpenFile, onOpenScratchpad, paths],
  );

  const followed = followingKey
    ? people.find((person) => person.key === followingKey)
    : undefined;

  useEffect(() => {
    if (!followingKey) {
      lastFollowedNodeId.current = undefined;
      return;
    }
    if (!followed) {
      setFollowingKey(null);
      lastFollowedNodeId.current = undefined;
      return;
    }
    if (followed.nodeId && followed.nodeId !== lastFollowedNodeId.current) {
      lastFollowedNodeId.current = followed.nodeId;
      jumpTo(followed.nodeId);
    }
  }, [followed, followingKey, jumpTo]);

  function fileLabel(nodeId: string | undefined) {
    if (!nodeId) return null;
    if (nodeId === scratchpadId) return "Scratchpad";
    return paths.get(nodeId) ?? null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={
              followed
                ? `Following ${followed.name} (${people.length} collaborators online)`
                : `${people.length} collaborators online`
            }
            title={
              followed
                ? `Following ${followed.name}`
                : people.map((person) => person.name).join(", ") ||
                  "Collaboration"
            }
          />
        }
      >
        {followed ? <IconEye /> : <IconUsers />}
        <span className="max-sm:hidden">
          {followed ? `Following ${followed.name}` : `${people.length} online`}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {people.length === 0
              ? "No one else online"
              : `${people.length} online`}
          </DropdownMenuLabel>
          {people.map((person) => {
            const location = fileLabel(person.nodeId);
            const isFollowing = followingKey === person.key;
            return (
              <div key={person.key} className="flex items-center gap-1 pr-1">
                <DropdownMenuItem
                  className="min-w-0 flex-1"
                  disabled={!location}
                  onClick={() => jumpTo(person.nodeId)}
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: person.color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {person.name}
                    </span>
                    {location && (
                      <span className="text-muted-foreground block truncate text-xs">
                        {location}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
                {location && (
                  <Button
                    type="button"
                    variant={isFollowing ? "secondary" : "ghost"}
                    size="icon-xs"
                    aria-label={
                      isFollowing
                        ? `Stop following ${person.name}`
                        : `Follow ${person.name}`
                    }
                    title={
                      isFollowing
                        ? `Stop following ${person.name}`
                        : `Follow ${person.name}`
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isFollowing) {
                        setFollowingKey(null);
                      } else {
                        setFollowingKey(person.key);
                        lastFollowedNodeId.current = person.nodeId;
                        jumpTo(person.nodeId);
                      }
                    }}
                  >
                    {isFollowing ? <IconEyeOff /> : <IconEye />}
                  </Button>
                )}
              </div>
            );
          })}
        </DropdownMenuGroup>
        {followed && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setFollowingKey(null)}>
              <IconEyeOff />
              Stop following {followed.name}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenCollaboration}>
          <IconUsers />
          Manage collaborators…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
