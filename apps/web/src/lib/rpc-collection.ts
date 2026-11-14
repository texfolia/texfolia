import { createCollection, type SyncConfig } from "@tanstack/react-db";

// Keep server snapshots beneath TanStack DB's optimistic transaction overlay.
export function createRpcCollection<T extends { id: string }>({
  initial,
  insert,
  remove,
}: {
  initial: T[];
  insert: (row: T) => Promise<T>;
  remove?: (row: T) => Promise<unknown>;
}) {
  let sync: Parameters<SyncConfig<T, string>["sync"]>[0];
  const utils = {
    replace(rows: T[]) {
      sync.begin({ snapshot: true });
      for (const row of rows) sync.write({ type: "insert", value: row });
      sync.commit();
    },
  };
  const collection = createCollection<T, string, typeof utils>({
    utils,
    getKey: (row) => row.id,
    startSync: true,
    gcTime: Infinity,
    sync: {
      rowUpdateMode: "full",
      sync: (callbacks) => {
        sync = callbacks;
        sync.begin({ snapshot: true });
        for (const row of initial) sync.write({ type: "insert", value: row });
        sync.commit();
        sync.markReady();
      },
    },
    onInsert: async ({ transaction }) => {
      if (transaction.mutations.length !== 1)
        throw new Error("RPC collections accept one row per operation");
      const [mutation] = transaction.mutations;
      const row = await insert(mutation.modified);
      sync.begin();
      sync.write({ type: "insert", value: row });
      // Acknowledgements apply when the optimistic transaction settles. Awaiting
      // the sync receipt here would deadlock that transaction.
      sync.commit();
    },
    ...(remove && {
      onDelete: async ({ transaction }) => {
        if (transaction.mutations.length !== 1)
          throw new Error("RPC collections accept one row per operation");
        const [mutation] = transaction.mutations;
        await remove(mutation.original);
        sync.begin();
        sync.write({ type: "delete", key: mutation.key });
        sync.commit();
      },
    }),
  });
  return collection;
}
