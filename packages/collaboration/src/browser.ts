// Browser-side collaboration: the Yjs document for an open file, its
// IndexedDB cache, and the localStorage draft cache for saved sources.
export { CollaborativeFile } from "./file";
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
