import { InputGroup, InputGroupTextarea } from "@texfolia/ui/input-group";
import type { ComponentProps } from "react";

export function PromptInput(props: ComponentProps<typeof InputGroupTextarea>) {
  return (
    <InputGroup>
      <InputGroupTextarea {...props} className="max-h-40 min-h-24 p-3" />
    </InputGroup>
  );
}
