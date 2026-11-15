import { useNavigate } from "@tanstack/react-router";

import { GitRemoteForm } from "#/components/git-remote-form";
import { importGitProject } from "#/lib/git.functions";

export function GitImport() {
  const navigate = useNavigate();
  return (
    <details className="max-w-lg rounded-md border px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">
        Import from GitHub or GitLab
      </summary>
      <div className="pt-4">
        <GitRemoteForm
          mode="import"
          onConnect={async (remote, name) => {
            const result = await importGitProject({ data: { remote, name } });
            await navigate({
              to: "/project/$projectId",
              params: { projectId: result.projectId },
            });
          }}
        />
      </div>
    </details>
  );
}
