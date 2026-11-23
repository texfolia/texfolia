import { IconChevronDown } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@texfolia/ui/dropdown-menu";

export function ModelSelector({
  models,
  value,
  defaultModel,
  onChange,
  disabled,
}: {
  models: { id: string; name: string }[];
  value: string;
  defaultModel: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" />}
        disabled={disabled}
        aria-label="Model for this chat"
        className="max-w-full min-w-0"
      >
        <span className="truncate">
          {models.find((model) => model.id === (value || defaultModel))?.name ??
            "Choose model"}
        </span>
        <IconChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value="" closeOnClick>
            Use default
          </DropdownMenuRadioItem>
          {models.map((model) => (
            <DropdownMenuRadioItem key={model.id} value={model.id} closeOnClick>
              {model.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
