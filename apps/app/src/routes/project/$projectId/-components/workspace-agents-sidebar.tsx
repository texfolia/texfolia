import { AssistantSidebar } from "#/features/ai/ui";
import type { WorkspaceChrome } from "#/features/workspace/workspace-layout";
import { webPath } from "#/lib/origins";

import { SidebarResize } from "./sidebar-resize";

/** The agents and chat-history sidebars on the left of the editor. */
export function WorkspaceAgentsSidebar({
  projectId,
  chrome,
  onChrome,
}: {
  projectId: string;
  chrome: WorkspaceChrome;
  onChrome: (patch: Partial<WorkspaceChrome>) => void;
}) {
  const width =
    (chrome.agentsOpen ? chrome.agentsWidth : 0) +
    (chrome.historyOpen
      ? chrome.historyWidth + (chrome.agentsOpen ? 4 : 0)
      : 0);
  return (
    <>
      <div
        hidden={!chrome.agentsOpen && !chrome.historyOpen}
        style={{ width }}
        className="z-30 h-full min-w-0 shrink-0 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:max-w-[85%] [&[hidden]]:hidden"
      >
        <AssistantSidebar
          endpoint={`/api/ai/${projectId}`}
          plansUrl={webPath("/pricing")}
          open={chrome.agentsOpen}
          onClose={() => onChrome({ agentsOpen: false })}
          historyOpen={chrome.historyOpen}
          historyWidth={chrome.historyWidth}
          agentsWidth={chrome.agentsWidth}
          onHistoryToggle={() => onChrome({ historyOpen: !chrome.historyOpen })}
          historyResize={
            <SidebarResize
              side="left"
              width={chrome.historyWidth}
              onResize={(historyWidth) => onChrome({ historyWidth })}
              label="Resize history sidebar"
            />
          }
          onShowAgents={() => onChrome({ agentsOpen: true })}
        />
      </div>
      {(chrome.agentsOpen || chrome.historyOpen) && (
        <SidebarResize
          side="left"
          width={chrome.agentsOpen ? chrome.agentsWidth : chrome.historyWidth}
          label={
            chrome.agentsOpen
              ? "Resize agents sidebar"
              : "Resize history sidebar"
          }
          onResize={(width) =>
            onChrome(
              chrome.agentsOpen
                ? { agentsWidth: width }
                : { historyWidth: width },
            )
          }
        />
      )}
    </>
  );
}
