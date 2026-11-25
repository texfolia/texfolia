import {
  IconAlertCircle,
  IconCircleCheck,
  IconFiles,
  IconGitBranch,
  IconHistory,
  IconLayoutSidebarLeftExpand,
  IconListTree,
  IconLoader2,
  IconMessage,
  IconNotes,
  IconPlayerPlay,
  IconSearch,
  IconTimeline,
  IconUsers,
} from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { useSyncExternalStore } from "react";

import type { WordCount } from "#/lib/editor/latex/word-count";
import type { Store } from "#/lib/external-store";
import type {
  PanelView,
  WorkspaceChrome,
} from "#/lib/workspace/workspace-layout";

import type { CompileStatus } from "../-hooks/use-compilation";
import type { Cursor } from "../-hooks/use-dock-panels";
import type { GitBranchState } from "../-hooks/use-workspace-session";
import { WordCountStatus } from "./word-count-status";
import { WorkspacePresence } from "./workspace-presence";

const sidebarViews = [
  { view: "files", label: "Files", icon: IconFiles },
  { view: "outline", label: "Outline", icon: IconListTree },
  { view: "search", label: "Search", icon: IconSearch },
  { view: "git", label: "Git", icon: IconGitBranch },
  { view: "comments", label: "Comments", icon: IconMessage },
  { view: "collaboration", label: "Collaboration", icon: IconUsers },
] satisfies {
  view: WorkspaceChrome["rightView"];
  label: string;
  icon: typeof IconFiles;
}[];

/** Subscribes by itself, so a moving cursor renders nothing else. */
function CursorPosition({ cursor }: { cursor: Store<Cursor | undefined> }) {
  const position = useSyncExternalStore(cursor.subscribe, cursor.get);
  if (!position) return null;
  return (
    <span className="shrink-0 px-2 tabular-nums">
      <span className="max-sm:hidden">
        Ln {position.line}, Col {position.column}
      </span>
      <span className="sm:hidden">
        {position.line}:{position.column}
      </span>
    </span>
  );
}

export function WorkspaceStatusBar({
  chrome,
  onChrome,
  onTogglePanel,
  problemCount,
  compileStatus,
  compileDisabled,
  onCompile,
  words,
  onRevealWords,
  git,
  scratchpadDisabled,
  onScratchpad,
  location,
  cursor,
}: {
  chrome: WorkspaceChrome;
  onChrome: (patch: Partial<WorkspaceChrome>) => void;
  onTogglePanel: (view: PanelView) => void;
  problemCount: number;
  compileStatus: CompileStatus;
  compileDisabled: boolean;
  onCompile: () => void;
  /** Omitted when the project has no main file. */
  words: WordCount | undefined;
  onRevealWords: (path: string, line: number) => void;
  git: GitBranchState;
  scratchpadDisabled: boolean;
  onScratchpad: () => void;
  /** The active tab's path. */
  location: string;
  cursor: Store<Cursor | undefined>;
}) {
  return (
    <footer
      aria-label="Workspace status"
      className="z-20 flex h-8 shrink-0 items-center gap-1 border-t bg-(--status-background) px-1 text-xs text-(--status-foreground)"
    >
      <Button
        variant="ghost"
        size="icon-xs"
        className="aria-pressed:bg-muted"
        aria-label="Toggle chat history"
        title="Chat history"
        aria-pressed={chrome.historyOpen}
        onClick={() => onChrome({ historyOpen: !chrome.historyOpen })}
      >
        <IconHistory />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="aria-pressed:bg-muted"
        aria-label="Toggle agents sidebar"
        aria-pressed={chrome.agentsOpen}
        onClick={() => onChrome({ agentsOpen: !chrome.agentsOpen })}
      >
        <IconLayoutSidebarLeftExpand />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        className="aria-pressed:bg-muted"
        aria-label={`Problems (${problemCount})`}
        aria-controls="workspace-panel"
        aria-pressed={chrome.panelOpen && chrome.panelView === "problems"}
        onClick={() => onTogglePanel("problems")}
      >
        <IconAlertCircle />
        <span className="max-sm:hidden">Problems</span> ({problemCount})
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="aria-pressed:bg-muted"
        aria-label="Compile logs"
        title="Compile logs"
        aria-controls="workspace-panel"
        aria-pressed={chrome.panelOpen && chrome.panelView === "logs"}
        onClick={() => onTogglePanel("logs")}
      >
        <IconTimeline />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        disabled={compileDisabled}
        onClick={onCompile}
        aria-label="Compile status"
        title={compileStatus}
      >
        {compileStatus === "Compiling…" ? (
          <IconLoader2 className="motion-safe:animate-spin" />
        ) : compileStatus === "Up to date" ? (
          <IconCircleCheck />
        ) : compileStatus === "Compile failed" ? (
          <IconAlertCircle />
        ) : (
          <IconPlayerPlay />
        )}
        <span className="max-sm:hidden">{compileStatus}</span>
      </Button>
      {words && <WordCountStatus words={words} onReveal={onRevealWords} />}
      <WorkspacePresence
        onClick={() =>
          onChrome({ rightOpen: true, rightView: "collaboration" })
        }
      />
      <Button
        variant="ghost"
        size="xs"
        aria-label="Open scratchpad"
        title="Scratchpad: shared project notes"
        disabled={scratchpadDisabled}
        onClick={onScratchpad}
      >
        <IconNotes />
        <span className="max-sm:hidden">Scratchpad</span>
      </Button>
      {(git.kind === "unavailable" || git.name) && (
        <Button
          variant="ghost"
          size="xs"
          className="max-sm:hidden"
          title={git.kind === "unavailable" ? git.message : undefined}
          onClick={() => onChrome({ rightOpen: true, rightView: "git" })}
        >
          {git.kind === "unavailable" ? (
            <>
              <IconAlertCircle />
              Git unavailable
            </>
          ) : (
            <>
              <IconGitBranch />
              {git.name}
            </>
          )}
        </Button>
      )}
      <span className="min-w-0 flex-1 truncate px-2 text-right max-sm:hidden">
        {location}
      </span>
      <CursorPosition cursor={cursor} />
      <div
        role="toolbar"
        aria-label="Right sidebar views"
        className="ml-auto flex shrink-0 items-center gap-0.5"
      >
        {sidebarViews.map(({ view, label, icon: Icon }) => (
          <Button
            key={view}
            variant="ghost"
            size="icon-xs"
            className="aria-pressed:bg-muted"
            aria-label={label}
            title={label}
            aria-controls="project-sidebar"
            aria-pressed={chrome.rightOpen && chrome.rightView === view}
            onClick={() =>
              onChrome({
                rightView: view,
                rightOpen: !(chrome.rightOpen && chrome.rightView === view),
              })
            }
          >
            <Icon />
          </Button>
        ))}
      </div>
    </footer>
  );
}
