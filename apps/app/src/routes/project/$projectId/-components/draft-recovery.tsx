import {
  serializeSourceDrafts,
  type SourceDraft,
} from "@texfolia/collaboration/browser";
import { downloadFile } from "@texfolia/storage/browser";
import { Button } from "@texfolia/ui/button";

/** Offers browser drafts that could not be migrated to the server. */
export function DraftRecovery({
  name,
  drafts,
  canRecover,
  onRecover,
  onDiscard,
}: {
  name: string;
  drafts: Record<string, SourceDraft>;
  canRecover: boolean;
  onRecover: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm"
      role="status"
    >
      <span>
        Unsaved browser drafts are available for {Object.keys(drafts).length}{" "}
        file(s). The server copy is open.
      </span>
      <Button size="sm" disabled={!canRecover} onClick={onRecover}>
        Recover drafts
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          downloadFile(
            new Blob([serializeSourceDrafts(drafts)], {
              type: "application/json",
            }),
            `${name}-browser-drafts.json`,
          );
        }}
      >
        Download drafts
      </Button>
      <Button size="sm" variant="ghost" onClick={onDiscard}>
        Keep server copy
      </Button>
    </div>
  );
}
