import { lazyPanel } from "#/components/lazy-panel";
import { useHasBeen } from "#/hooks/use-has-been";
import type { Store } from "#/lib/external-store";
import { webPath } from "#/lib/origins";
import type { WorkspaceChrome } from "#/lib/workspace/workspace-layout";

import { useAssistantEditor } from "../-hooks/use-assistant-editor";
import { SidebarResize } from "./sidebar-resize";

const AssistantSidebar = lazyPanel("The assistant", async () => {
  const { AssistantSidebar } = await import("#/lib/ai/ui");
  return AssistantSidebar;
});

/** The agents and chat-history sidebars on the left of the editor. */
export function WorkspaceAgentsSidebar({
  projectId,
  prompt,
  chrome,
  onChrome,
}: {
  projectId: string;
  /** A request from the editor for the assistant to take. */
  prompt: Store<string | null>;
  chrome: WorkspaceChrome;
  onChrome: (patch: Partial<WorkspaceChrome>) => void;
}) {
  const editor = useAssistantEditor(prompt);
  const shown = chrome.agentsOpen || chrome.historyOpen;
  // Stays mounted once opened, so that hiding it does not stop a reply.
  const used = useHasBeen(shown);
  const width =
    (chrome.agentsOpen ? chrome.agentsWidth : 0) +
    (chrome.historyOpen
      ? chrome.historyWidth + (chrome.agentsOpen ? 1 : 0)
      : 0);
  return (
    <>
      <div
        hidden={!shown}
        style={{ width }}
        className="z-30 h-full min-w-0 shrink-0 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:max-w-[85%] [&[hidden]]:hidden"
      >
        {used && (
          <AssistantSidebar
            endpoint={`/api/ai/${projectId}`}
            editor={editor}
            plansUrl={webPath("/pricing")}
            open={chrome.agentsOpen}
            onClose={() => onChrome({ agentsOpen: false })}
            historyOpen={chrome.historyOpen}
            historyWidth={chrome.historyWidth}
            agentsWidth={chrome.agentsWidth}
            onHistoryToggle={() =>
              onChrome({ historyOpen: !chrome.historyOpen })
            }
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
        )}
      </div>
      {shown && (
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
