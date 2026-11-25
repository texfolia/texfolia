import assert from "node:assert/strict";
import { test } from "node:test";

import { headingIds } from "./markdown-headings.mjs";

test("names headings as GitHub and Starlight do", () => {
  const ids = headingIds(`---
# not a heading
---

## Forward Stripe webhooks
### Use \`db:push\`, then [seed](/templates/)
## AI & billing – caps_per user ##
## Trash
## Trash
<a id="custom"></a>

\`\`\`sh
# a comment
\`\`\`
`);
  assert.deepEqual(
    [...ids].sort(),
    [
      "_top",
      "ai--billing--caps_per-user",
      "custom",
      "forward-stripe-webhooks",
      "trash",
      "trash-1",
      "use-dbpush-then-seed",
    ].sort(),
  );
});
