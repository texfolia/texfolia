// Adds the rest of the workspace's server functions to the upload fixture's.
export * from "../workspace-upload/rpc";

export async function listComments() {
  return { threads: [], canModerate: false, userId: "runtime-test" };
}
async function unavailable() {
  throw new Error("Outside the editor runtime fixture");
}
export {
  unavailable as createCommentThread,
  unavailable as createShareLink,
  unavailable as createProject,
  unavailable as deleteCommentThread,
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
