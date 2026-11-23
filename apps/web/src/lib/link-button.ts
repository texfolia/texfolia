import { buttonVariants } from "@texfolia/ui/button";
import { cn } from "cn";

// Larger than the product's buttons. Heights include the variants' 1px border.
const sizes = {
  default: "h-10.5 gap-2 px-5",
  lg: "h-11.5 gap-2 px-6 text-base",
};

/** Classes for a link styled as the shared button, at a marketing size. */
export function linkButton({
  variant = "default",
  size = "default",
  className,
}: {
  variant?: "default" | "outline";
  size?: keyof typeof sizes;
  className?: string;
} = {}) {
  return cn(buttonVariants({ variant }), sizes[size], className);
}
