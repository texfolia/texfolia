// Adds the rest of the workspace's server functions to the upload fixture's.
export * from "../workspace-upload/rpc";

export async function listComments() {
  const response = await fetch("/fixture/comments");
  if (!response.ok)
    return { threads: [], canModerate: false, userId: "runtime-test" };
  return JSON.parse(await response.text(), (key, value: unknown) =>
    key === "createdAt" ? new Date(String(value)) : value,
  ) as unknown;
}
export async function deleteCommentThread({
  data,
}: {
  data: { threadId: string };
}) {
  await fetch("/fixture/comments/delete-thread", {
    method: "POST",
    body: JSON.stringify(data),
  });
}
export async function updateProjectMainFile({
  data,
}: {
  data: { mainFile: string | null };
}) {
  const response = await fetch("/fixture/main-file", {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(await response.text());
}
async function unavailable() {
  throw new Error("Outside the editor runtime fixture");
}
export {
  unavailable as createCommentThread,
  unavailable as createShareLink,
  unavailable as createProject,
  unavailable as deleteComment,
  unavailable as deleteProject,
  unavailable as updateComment,
  unavailable as listShareLinks,
  unavailable as getProjects,
  unavailable as getProject,
  unavailable as replyToCommentThread,
  unavailable as resolveCommentThread,
  unavailable as revokeShareLink,
  unavailable as updateProjectSpelling,
};
