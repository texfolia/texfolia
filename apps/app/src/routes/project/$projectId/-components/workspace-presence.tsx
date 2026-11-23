import { IconUsers } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { useEffect, useState } from "react";

import { useWorkspace } from "#/providers/workspace-provider";

export function WorkspacePresence({ onClick }: { onClick: () => void }) {
  const { collaboration } = useWorkspace();
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => {
    const refresh = () => {
      const names = new Map<string, string>();
      for (const file of collaboration.values())
        // The list covers the whole project, not only this file.
        for (const { name, color } of file.getStatus().people)
          names.set(`${name}:${color}`, name);
      const next = [...names.values()].sort();
      setPeople((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const unsubscribe = [...collaboration.values()].map((file) =>
      file.subscribe(refresh),
    );
    refresh();
    return () => unsubscribe.forEach((stop) => stop());
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
