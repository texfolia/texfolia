import { IconX } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@texfolia/ui/tabs";

import { ResizeHandle } from "#/components/resize-handle";
import {
  panelHeightBounds,
  type PanelView,
} from "#/lib/workspace/workspace-layout";

import { WorkspaceLogs } from "./workspace-logs";
import { WorkspaceProblems } from "./workspace-problems";
import { WorkspaceTerminal } from "./workspace-terminal";

// IDE-style bottom panel. It opens only when the user asks for it.
export function WorkspacePanel({
  view,
  height,
  problemCount,
  openedAt,
  onView,
  onResize,
  onClose,
}: {
  view: PanelView;
  height: number;
  problemCount: number;
  // performance.now() when the editor opened; Logs lists compiles since then.
  openedAt: number;
  onView: (view: PanelView) => void;
  onResize: (height: number) => void;
  onClose: () => void;
}) {
  return (
    <>
      <ResizeHandle
        label="Resize panel"
        grows="up"
        size={height}
        bounds={panelHeightBounds}
        controls="workspace-panel"
        onResize={onResize}
        className="z-10"
      />
      <Tabs
        value={view}
        onValueChange={(value) => onView(value as PanelView)}
        style={{ height }}
        className="bg-background shrink-0 gap-0 max-md:max-h-[60%]"
        id="workspace-panel"
      >
        <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
          <TabsList variant="line" aria-label="Panel views" className="h-7!">
            <TabsTrigger value="problems" className="px-2 text-xs">
              Problems ({problemCount})
            </TabsTrigger>
            <TabsTrigger value="logs" className="px-2 text-xs">
              Logs
            </TabsTrigger>
            <TabsTrigger value="terminal" className="px-2 text-xs">
              Terminal
            </TabsTrigger>
          </TabsList>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label="Close panel"
            title="Close panel"
            onClick={onClose}
          >
            <IconX />
          </Button>
        </div>
        <TabsContent value="problems" className="min-h-0 overflow-hidden">
          <WorkspaceProblems />
        </TabsContent>
        <TabsContent value="logs" className="min-h-0 overflow-hidden">
          <WorkspaceLogs openedAt={openedAt} />
        </TabsContent>
        <TabsContent value="terminal" className="min-h-0 overflow-hidden">
          <WorkspaceTerminal onLogs={() => onView("logs")} />
        </TabsContent>
      </Tabs>
    </>
  );
}
