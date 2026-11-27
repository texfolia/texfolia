// Adds the rest of the workspace's server functions to the upload fixture's.
export * from "../workspace-upload/rpc";

export async function listComments() {
  const response = await fetch("/fixture/comments");
  if (!response.ok)
    return {
      threads: [],
      canComment: true,
      canModerate: false,
      userId: "runtime-test",
    };
  return JSON.parse(await response.text(), (key, value: unknown) =>
    key === "createdAt" ? new Date(String(value)) : value,
  ) as unknown;
}
export async function getCommentThread({
  data,
}: {
  data: { projectId: string; threadId: string };
}) {
  const all = (await listComments()) as {
    userId: string;
    canComment: boolean;
    canModerate: boolean;
    threads: Array<{ id: string }>;
  };
  return {
    userId: all.userId,
    canComment: all.canComment,
    canModerate: all.canModerate,
    thread: all.threads.find((item) => item.id === data.threadId) ?? null,
  };
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
