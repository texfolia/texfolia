import type { IDockviewPanelProps } from "dockview-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { scratchpadId } from "#/lib/collaboration";
import { scratchpadMentionExtension } from "#/lib/mentions/codemirror";
import { resolveScratchpadMentions } from "#/lib/mentions/mentions.functions";
import {
  extractMentionedUserIds,
  type ResolvedMention,
} from "#/lib/mentions/tokens";
import {
  useWorkspace,
  useWorkspaceActions,
} from "#/providers/workspace-provider";

import { scratchpadTitle } from "../-hooks/use-dock-panels";
import { DocumentEditor } from "./document-editor";

const emptySubscribe = () => () => {};

/** The project's shared Markdown notes, which are not a project file. */
export function ScratchpadEditor({ api }: IDockviewPanelProps) {
  const { projectId, openMarkdownPreview } = useWorkspaceActions();
  const { scratchpad, formatSettings, mentionCandidates } = useWorkspace();
  const canWrite = useSyncExternalStore(
    scratchpad?.subscribe ?? emptySubscribe,
    () => scratchpad?.getStatus().canWrite,
  );
  const openPreview = useCallback(
    () => openMarkdownPreview(scratchpadId),
    [openMarkdownPreview],
  );

  const candidatesRef = useRef(mentionCandidates);
  candidatesRef.current = mentionCandidates;
  const [historicalMentions, setHistoricalMentions] = useState<
    Record<string, ResolvedMention>
  >({});

  const resolvedMap = useMemo(() => {
    const map = new Map<string, ResolvedMention>();
    for (const [id, item] of Object.entries(historicalMentions))
      map.set(id, item);
    for (const person of mentionCandidates) {
      map.set(person.id, {
        id: person.id,
        name: person.name,
        image: person.image,
        status: "active",
      });
    }
    return map;
  }, [mentionCandidates, historicalMentions]);
  const resolvedRef = useRef(resolvedMap);
  resolvedRef.current = resolvedMap;

  // Resolve any mention IDs in the scratchpad that are no longer active project
  // members so they render as "Former collaborator" or "Deleted user" chips.
  useEffect(() => {
    if (!scratchpad) return;
    const text = scratchpad.text.toString();
    const activeIds = new Set(mentionCandidates.map((person) => person.id));
    const unresolved = extractMentionedUserIds(text).filter(
      (id) => !activeIds.has(id) && !(id in historicalMentions),
    );
    if (!unresolved.length) return;
    let live = true;
    void resolveScratchpadMentions({
      data: { projectId, userIds: unresolved },
    })
      .then((result) => {
        if (live)
          setHistoricalMentions((current) => ({
            ...current,
            ...result.mentions,
          }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, scratchpad, mentionCandidates, historicalMentions]);

  const mentionExtension = useMemo(
    () =>
      scratchpadMentionExtension({
        getCandidates: () => candidatesRef.current,
        getResolved: (userId) => resolvedRef.current.get(userId),
      }),
    // Recreate when candidate/historical profiles update so live chips refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref reads stay fresh; resolvedMap triggers refresh
    [resolvedMap],
  );

  return (
    <DocumentEditor
      id={scratchpadId}
      panelApi={api}
      collaboration={scratchpad}
      // The server decides, because draft recovery only pauses source edits.
      canWrite
      // Names the language and the downloaded copy.
      filename="scratchpad.md"
      labels={{
        title: scratchpadTitle,
        region: "Scratchpad editor",
        source: "Scratchpad",
        placeholder: canWrite
          ? "Shared Markdown notes for this project… Type @ to mention someone."
          : "No notes yet.",
      }}
      autosaved
      allowOpenFile={false}
      formatSettings={formatSettings}
      extraExtension={mentionExtension}
      onOpenPreview={openPreview}
    />
  );
}
