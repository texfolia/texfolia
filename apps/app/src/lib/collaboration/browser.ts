// Browser-side collaboration: the project's live documents, the Yjs document
// for an open file, its IndexedDB cache, and the localStorage draft cache for
// saved sources.
export { CollaborationConnection } from "./connection";
export { CollaborativeFile } from "./file";
export { CollaborativeDocuments } from "./documents";
export {
  clearCollaborationCaches,
  collaborationCachePrefix,
  documentCachingStopped,
  stopDocumentCaching,
} from "./cache";
export {
  reconcileSourceDrafts,
  serializeSourceDrafts,
  type SourceDraft,
} from "./drafts";
