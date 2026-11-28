/** A weak entity tag for `value`, which must be valid inside quotes. */
export function weakEtag(value: string) {
  return `W/"${value}"`;
}

/** Whether a request's `If-None-Match` names `etag`, compared weakly. */
export function matchesEtag(request: Request, etag: string) {
  const header = request.headers.get("If-None-Match");
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return header
    .split(",")
    .some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}
