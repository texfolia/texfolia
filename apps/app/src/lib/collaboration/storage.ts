const chunkBytes = 1024 * 1024;

export function initializeChunks(sql: SqlStorage) {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS snapshot_chunks (node_id TEXT, part INTEGER, data BLOB NOT NULL, PRIMARY KEY (node_id, part))",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS update_chunks (update_id INTEGER, part INTEGER, data BLOB NOT NULL, PRIMARY KEY (update_id, part))",
  );
}

function joinChunks(head: ArrayBuffer, rest: Iterable<{ data: ArrayBuffer }>) {
  const chunks = [
    new Uint8Array(head),
    ...Array.from(rest, (row) => new Uint8Array(row.data)),
  ];
  const bytes = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function readSnapshot(
  sql: SqlStorage,
  nodeId: string,
  head: ArrayBuffer,
) {
  return joinChunks(
    head,
    sql.exec<{ data: ArrayBuffer }>(
      "SELECT data FROM snapshot_chunks WHERE node_id = ? ORDER BY part",
      nodeId,
    ),
  );
}

export function writeSnapshot(
  sql: SqlStorage,
  nodeId: string,
  bytes: Uint8Array,
) {
  sql.exec(
    "UPDATE documents SET snapshot = ? WHERE node_id = ?",
    bytes.subarray(0, chunkBytes),
    nodeId,
  );
  sql.exec("DELETE FROM snapshot_chunks WHERE node_id = ?", nodeId);
  for (let offset = chunkBytes; offset < bytes.length; offset += chunkBytes)
    sql.exec(
      "INSERT INTO snapshot_chunks (node_id, part, data) VALUES (?, ?, ?)",
      nodeId,
      offset / chunkBytes,
      bytes.subarray(offset, offset + chunkBytes),
    );
}

export function appendUpdate(
  sql: SqlStorage,
  nodeId: string,
  bytes: Uint8Array,
) {
  const { id } = sql
    .exec<{ id: number }>(
      "INSERT INTO updates (node_id, data, bytes) VALUES (?, ?, ?) RETURNING id",
      nodeId,
      bytes.subarray(0, chunkBytes),
      bytes.length,
    )
    .one();
  for (let offset = chunkBytes; offset < bytes.length; offset += chunkBytes)
    sql.exec(
      "INSERT INTO update_chunks (update_id, part, data) VALUES (?, ?, ?)",
      id,
      offset / chunkBytes,
      bytes.subarray(offset, offset + chunkBytes),
    );
}

export function* readUpdates(sql: SqlStorage, nodeId: string) {
  for (const update of sql.exec<{ id: number; data: ArrayBuffer }>(
    "SELECT id, data FROM updates WHERE node_id = ? ORDER BY id",
    nodeId,
  ))
    yield joinChunks(
      update.data,
      sql.exec<{ data: ArrayBuffer }>(
        "SELECT data FROM update_chunks WHERE update_id = ? ORDER BY part",
        update.id,
      ),
    );
}

export function deleteUpdates(sql: SqlStorage, nodeId: string) {
  sql.exec(
    "DELETE FROM update_chunks WHERE update_id IN (SELECT id FROM updates WHERE node_id = ?)",
    nodeId,
  );
  sql.exec("DELETE FROM updates WHERE node_id = ?", nodeId);
}
