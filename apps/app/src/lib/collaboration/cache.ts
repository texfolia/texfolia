export function collaborationCachePrefix(userId: string) {
  return `texfolia.yjs.${userId}.`;
}

let cachingStopped = false;
export function documentCachingStopped() {
  return cachingStopped;
}
export function stopDocumentCaching() {
  cachingStopped = true;
}

export async function clearCollaborationCaches(userId: string) {
  const databases =
    typeof indexedDB === "undefined" ? [] : await indexedDB.databases();
  const prefix = collaborationCachePrefix(userId);
  await Promise.all(
    databases.flatMap(({ name }) =>
      name?.startsWith(prefix)
        ? [
            new Promise<void>((resolve, reject) => {
              const request = indexedDB.deleteDatabase(name);
              request.onsuccess = () => resolve();
              request.onerror = () => reject(request.error);
              request.onblocked = () =>
                reject(
                  new Error("Local document cache is open in another tab."),
                );
            }),
          ]
        : [],
    ),
  );
  const layoutPrefix = `texfolia.workspace.layout.v1:${userId}:`;
  const keys = Object.keys(localStorage);
  for (const key of keys) {
    if (
      key.startsWith(layoutPrefix) ||
      (key.startsWith("texfolia.project.") && key.endsWith(".sources"))
    )
      localStorage.removeItem(key);
  }
}
