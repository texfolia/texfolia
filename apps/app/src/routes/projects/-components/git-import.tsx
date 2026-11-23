import { useNavigate } from "@tanstack/react-router";

import { GitRemoteForm } from "#/components/git-remote-form";
import { importGitProject } from "#/features/git/git.functions";

export function GitImport({
  onPendingChange,
}: {
  onPendingChange: (pending: boolean) => void;
}) {
  const navigate = useNavigate();
  return (
    <GitRemoteForm
      mode="import"
      onConnect={async (remote, name) => {
        onPendingChange(true);
        try {
          const result = await importGitProject({ data: { remote, name } });
          await navigate({
            to: "/project/$projectId",
            params: { projectId: result.projectId },
          });
        } finally {
          onPendingChange(false);
        }
      }}
    />
  );
}
