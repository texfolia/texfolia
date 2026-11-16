import { Tag, tags } from "@lezer/highlight";

export const latexTags = {
  command: Tag.define(tags.keyword),
  environment: Tag.define(tags.className),
  math: Tag.define(tags.variableName),
  argument: Tag.define(tags.string),
  option: Tag.define(tags.attributeName),
  key: Tag.define(tags.propertyName),
  bibField: Tag.define(tags.propertyName),
};
