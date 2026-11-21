/**
 * Returns a stand-in for the object `create` builds, building it on first
 * property access. Request context is copied property by property, so a getter
 * on the context would run on every request; the proxy defers the work until a
 * caller actually uses the object.
 */
export function lazy<T extends object>(create: () => T): T {
  let value: T | undefined;
  return new Proxy({} as T, {
    get(_, key) {
      value ??= create();
      const property: unknown = Reflect.get(value, key);
      return typeof property === "function" ? property.bind(value) : property;
    },
    has: (_, key) => Reflect.has((value ??= create()), key),
  });
}
