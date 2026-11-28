import { defineGitProvider } from "./types";

export const gitlab = defineGitProvider({
  id: "gitlab",
  label: "GitLab",
  host: "gitlab.com",
  scopes: ["read_repository", "write_repository"],
  tokenUsername: "oauth2",
  // GitLab nests projects in groups and subgroups.
  isRepositoryPath: (segments) => segments.length >= 2,
  exampleUrl: "https://gitlab.com/group/project",
});
