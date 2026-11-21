import type { ComponentProps } from "react";

import { InputGroup, InputGroupTextarea } from "#/components/ui/input-group";

export function PromptInput(props: ComponentProps<typeof InputGroupTextarea>) {
  return (
    <InputGroup>
      <InputGroupTextarea {...props} className="max-h-40 min-h-24 p-3" />
    </InputGroup>
  );
}
