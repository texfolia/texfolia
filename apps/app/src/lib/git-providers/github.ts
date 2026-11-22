import { defineGitProvider } from "./types";

export const github = defineGitProvider({
  id: "github",
  label: "GitHub",
  host: "github.com",
  scopes: ["repo"],
  tokenUsername: "oauth2",
  // GitHub repositories are always owner/name.
  isRepositoryPath: (segments) => segments.length === 2,
  exampleUrl: "https://github.com/owner/repository",
});
