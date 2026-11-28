import { IconTerminal2 } from "@tabler/icons-react";

import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";

// The Terminal tab. What it runs is still open (NAT-414): for example a
// read-only stream of compiler output, or an interactive shell in the compile
// container, which needs its own security review. Until then it says so.
export function WorkspaceTerminal({ onLogs }: { onLogs: () => void }) {
  return (
    <section aria-label="Terminal" className="h-full overflow-auto">
      <Empty className="h-full border-0 p-4">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconTerminal2 />
          </EmptyMedia>
          <EmptyTitle>No terminal yet</EmptyTitle>
          <EmptyDescription className="max-w-sm">
            Texfolia doesn’t offer a shell yet. Compile output and timing are in
            Logs.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onLogs}>
            Open Logs
          </Button>
        </EmptyContent>
      </Empty>
    </section>
  );
}
