import { IconUsers } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { useEffect, useState } from "react";
import { z } from "zod";

import { useWorkspace } from "#/providers/workspace-provider";

const presenceSchema = z.object({
  user: z.object({ name: z.string(), color: z.string() }),
});

export function WorkspacePresence({ onClick }: { onClick: () => void }) {
  const { collaboration } = useWorkspace();
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => {
    const refresh = () => {
      const names = new Map<string, string>();
      for (const file of collaboration.values())
        for (const state of file.awareness.getStates().values()) {
          const parsed = presenceSchema.safeParse(state);
          if (parsed.success)
            names.set(
              `${parsed.data.user.name}:${parsed.data.user.color}`,
              parsed.data.user.name,
            );
        }
      const next = [...names.values()].sort();
      setPeople((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    for (const file of collaboration.values())
      file.awareness.on("change", refresh);
    refresh();
    return () => {
      for (const file of collaboration.values())
        file.awareness.off("change", refresh);
    };
  }, [collaboration]);
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={`${people.length} collaborators online`}
      title={people.join(", ") || "Collaboration"}
      onClick={onClick}
    >
      <IconUsers />
      <span className="max-sm:hidden">{people.length} online</span>
    </Button>
  );
}
