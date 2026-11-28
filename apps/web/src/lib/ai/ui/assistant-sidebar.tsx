import { IconX } from "@tabler/icons-react";
import { Button, buttonVariants } from "@texfolia/ui/button";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { AssistantEditor } from "../editor";
import { aiConfigurationSchema, type AiConfiguration } from "../schema";
import { AssistantChat } from "./assistant-chat";
import { responseError } from "./assistant-client";
import { AssistantHistory } from "./assistant-history";

type Availability =
  | { kind: "loading" }
  | { kind: "ready"; config: AiConfiguration }
  | { kind: "unavailable"; message: string; upgrade: boolean };

export function AssistantSidebar({
  endpoint,
  editor,
  plansUrl,
  open,
  onClose,
  historyOpen,
  historyWidth,
  agentsWidth,
  historyResize,
  onHistoryToggle,
  onShowAgents,
}: {
  historyOpen: boolean;
  historyWidth: number;
  agentsWidth: number;
  /** The resize handle between history and the chat, when both are open. */
  historyResize: ReactNode;
  onHistoryToggle: () => void;
  onShowAgents: () => void;
  /** The project's assistant route. */
  endpoint: string;
  /** Where to send users whose plan has no assistant. */
  plansUrl: string;
  /** The workspace around the panel. */
  editor: AssistantEditor;
  open: boolean;
  onClose: () => void;
}) {
  const [availability, setAvailability] = useState<Availability>({
    kind: "loading",
  });
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(endpoint, { signal });
        const body: unknown = await response.json();
        if (!response.ok) {
          setAvailability({
            kind: "unavailable",
            message: responseError(
              body,
              "The assistant could not load. Try again.",
            ),
            upgrade: response.status === 403,
          });
          return;
        }
        setAvailability({
          kind: "ready",
          config: aiConfigurationSchema.parse(body),
        });
      } catch {
        if (!signal?.aborted)
          setAvailability({
            kind: "unavailable",
            message:
              "The assistant could not connect. Check your connection and try again.",
            upgrade: false,
          });
      }
    },
    [endpoint],
  );
  const updateConfiguration = useCallback(
    (config: AiConfiguration) => setAvailability({ kind: "ready", config }),
    [],
  );
  const refreshConfiguration = useCallback(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  return (
    <div className="flex h-full min-w-0 max-md:w-full">
      {availability.kind !== "ready" && (
        <>
          {historyOpen && (
            <aside
              aria-label="Agent history"
              style={{ width: historyWidth }}
              className="bg-sidebar flex shrink-0 flex-col border-r"
            >
              <header className="flex h-9 items-center border-b px-2 text-xs">
                Chat history
              </header>
              <p className="text-muted-foreground p-3 text-xs">
                {availability.kind === "loading"
                  ? "Loading history…"
                  : "Chat history requires assistant access."}
              </p>
            </aside>
          )}
          <aside
            aria-label="AI assistant"
            hidden={!open}
            style={{ width: agentsWidth }}
            className="bg-sidebar text-sidebar-foreground flex h-full min-w-0 flex-col max-md:w-full! [&[hidden]]:hidden"
          >
            <header className="flex min-h-9 items-center gap-2 border-b px-3">
              <h2 className="flex-1 text-xs font-medium">Agents</h2>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close assistant"
                onClick={onClose}
              >
                <IconX />
              </Button>
            </header>
            {availability.kind === "loading" && (
              <p role="status" className="p-4 text-sm">
                Loading assistant…
              </p>
            )}
            {availability.kind === "unavailable" && (
              <div className="space-y-4 p-4 text-sm">
                <p role="status">{availability.message}</p>
                {availability.upgrade ? (
                  <a href={plansUrl} className={buttonVariants()}>
                    View Pro plans
                  </a>
                ) : (
                  <Button variant="ghost" onClick={() => void load()}>
                    Try again
                  </Button>
                )}
              </div>
            )}
          </aside>
        </>
      )}
      {availability.kind === "ready" && (
        <AssistantHistory
          endpoint={endpoint}
          prompt={editor.prompt}
          historyOpen={historyOpen}
          historyWidth={historyWidth}
          agentsOpen={open}
          agentsWidth={agentsWidth}
          onHistoryToggle={onHistoryToggle}
          historyResize={historyResize}
          onShowAgents={onShowAgents}
          onCloseAgents={onClose}
        >
          <AssistantChat
            endpoint={endpoint}
            editor={editor}
            config={availability.config}
            onConfiguration={updateConfiguration}
            refresh={refreshConfiguration}
          />
        </AssistantHistory>
      )}
    </div>
  );
}
