import { Button } from "@texfolia/ui/button";
import { Input } from "@texfolia/ui/input";
import { Textarea } from "@texfolia/ui/textarea";
import { useState } from "react";

import type { Git } from "../-hooks/use-git";

export function GitCommitForm({ git }: { git: Git }) {
  const { message } = git;
  const busy = !!git.busy;
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void git.act({ kind: "commit", message });
      }}
    >
      <label className="block space-y-1">
        <span>Commit message</span>
        <Textarea
          required
          maxLength={5000}
          value={message}
          onChange={(event) => git.changeMessage(event.target.value)}
          disabled={busy}
          className="min-h-16 text-xs"
        />
      </label>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" type="submit" disabled={busy || !message.trim()}>
          {git.busy === "commit" ? "Committing…" : "Commit changes"}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => void git.generate()}
        >
          {git.busy === "generate" ? "Generating…" : "Generate message · Pro"}
        </Button>
      </div>
      <p className="text-muted-foreground">
        AI usage is metered. Ignored files and out/ are excluded.
      </p>
    </form>
  );
}

export function GitBranchForm({ git }: { git: Git }) {
  const [branch, setBranch] = useState("");
  const busy = !!git.busy;
  return (
    <form
      className="flex gap-1"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await git.act({ kind: "branch", name: branch })) setBranch("");
      }}
    >
      <Input
        aria-label="New branch name"
        placeholder="New branch name"
        value={branch}
        onChange={(event) => setBranch(event.target.value)}
        disabled={busy}
        required
        className="min-w-0 text-xs"
      />
      <Button
        size="sm"
        variant="ghost"
        type="submit"
        disabled={busy || !branch.trim()}
      >
        Create
      </Button>
    </form>
  );
}
