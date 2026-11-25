/** Keeps the `limit` most recently used entries. */
export class LruCache<K, V> {
  private entries = new Map<K, V>();
  constructor(private limit: number) {}

  get size() {
    return this.entries.size;
  }

  has(key: K) {
    return this.entries.has(key);
  }

  get(key: K) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V) {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size <= this.limit) return;
    for (const oldest of this.entries.keys()) {
      this.entries.delete(oldest);
      return;
    }
  }

  delete(key: K) {
    return this.entries.delete(key);
  }
}
