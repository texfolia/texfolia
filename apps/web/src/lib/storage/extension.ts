/** A filename's extension in lower case, without the dot. */
export function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}
