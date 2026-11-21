import { Button } from "@texfolia/ui/button";

export function Suggestion({
  children,
  onClick,
}: {
  children: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-auto justify-start py-2 text-left whitespace-normal"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
