import { styleTags, tags } from "@lezer/highlight";

import { latexTags } from "./tags.js";

export const bibtexHighlighting = styleTags({
  "EntryType StringType PreambleType CommentType": tags.keyword,
  "EntryKey/...": tags.labelName,
  "FieldName/...": latexTags.bibField,
  "BracedValue/... QuotedValue": tags.string,
  "CommentEntry/...": tags.comment,
  Comment: tags.comment,
  Number: tags.number,
  Identifier: tags.variableName,
  '"=" "#"': tags.operator,
  "{ }": tags.brace,
  "( )": tags.paren,
  ",": tags.separator,
});
