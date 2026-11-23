import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

import { clearCollaborationCaches } from "#/features/collaboration/browser";
import { CollaborativeFile } from "#/features/collaboration/browser";

import { signOut } from "../../src/lib/sign-out";

let file: CollaborativeFile | undefined;
let blocker: IDBDatabase | undefined;
const api = {
  signOut,
  clearCollaborationCaches,
  async seed(name: string, value: string) {
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(name, doc);
    await persistence.whenSynced;
    doc.getText("source").insert(0, value);
    await persistence.set("initialized", 1);
    await persistence.destroy();
    doc.destroy();
  },
  async open(userId: string) {
    file = new CollaborativeFile({
      userId,
      projectId: "project",
      nodeId: "node",
      canWrite: true,
      onChange: () => {},
    });
    await file.whenConnected();
  },
  replace: (value: string) => file?.replace(value),
  value: () => file?.text.toString(),
  connected: () => file?.getStatus().connected,
  async read(name: string) {
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(name, doc);
    await persistence.whenSynced;
    const value = doc.getText("source").toString();
    await persistence.destroy();
    doc.destroy();
    return value;
  },
  names: async () =>
    (await indexedDB.databases()).map(({ name }) => name).sort(),
  block: (name: string) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        blocker = request.result;
        resolve();
      };
      request.onerror = () => reject(request.error);
    }),
  unblock: () => blocker?.close(),
};
Object.assign(window, { cacheTest: api });
export type CacheTestApi = typeof api;
