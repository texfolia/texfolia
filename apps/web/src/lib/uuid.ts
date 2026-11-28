// Route modules stay in the first bundle of every page, so they check IDs with
// this rather than Zod. It accepts what `z.uuid()` accepts.
const uuid =
  /^(?:[\da-fA-F]{8}-[\da-fA-F]{4}-[1-8][\da-fA-F]{3}-[89abAB][\da-fA-F]{3}-[\da-fA-F]{12}|0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12})$/;

export function isUuid(value: string) {
  return uuid.test(value);
}
