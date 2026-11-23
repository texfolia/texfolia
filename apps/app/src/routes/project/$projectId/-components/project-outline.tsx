import { Button } from "@texfolia/ui/button";

import type { OutlineEntry } from "#/features/editor/latex/outline";
import { useWorkspace } from "#/providers/workspace-provider";

export function ProjectOutline({ entries }: { entries: OutlineEntry[] }) {
  const { reveal } = useWorkspace();
  function branch(items: OutlineEntry[]) {
    return (
      <ul className="space-y-0.5">
        {items.map((entry, index) => (
          <li key={`${entry.path}:${entry.line}:${index}`}>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto min-h-8 w-full justify-start py-1.5 text-left whitespace-normal"
              title={`${entry.path}:${entry.line}`}
              onClick={() => reveal(entry.path, entry.line)}
            >
              {entry.title}
            </Button>
            {!!entry.children.length && (
              <div className="ml-3 border-l pl-1">{branch(entry.children)}</div>
            )}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <nav aria-label="Document outline" className="p-2">
      {entries.length ? (
        branch(entries)
      ) : (
        <p className="text-muted-foreground p-2 text-xs">
          Section headings from your main document and included files appear
          here.
        </p>
      )}
    </nav>
  );
}
