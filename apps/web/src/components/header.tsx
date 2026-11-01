import { Link } from "@tanstack/react-router";
import { cn } from "cn";

import { buttonVariants } from "#/components/ui/button";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from "#/components/ui/navigation-menu";

export function Header() {
  return (
    <header className="bg-background/75 sticky top-0 z-50 w-full p-4 backdrop-blur-sm">
      <div className="mx-auto flex max-w-7xl items-center justify-center">
        <Link to="/" className="mr-auto font-serif text-2xl">
          Texfolia
        </Link>
        <NavigationMenu>
          <NavigationMenuList>
            <NavigationMenuItem>
              <NavigationMenuTrigger>Platform</NavigationMenuTrigger>
              <NavigationMenuContent>
                <NavigationMenuLink>Link</NavigationMenuLink>
              </NavigationMenuContent>
            </NavigationMenuItem>
            <NavigationMenuItem>
              <NavigationMenuTrigger>Features</NavigationMenuTrigger>
              <NavigationMenuContent>
                <NavigationMenuLink>Link</NavigationMenuLink>
              </NavigationMenuContent>
            </NavigationMenuItem>
            <NavigationMenuItem>
              <NavigationMenuLink
                href="/pricing"
                className={navigationMenuTriggerStyle()}
              >
                Pricing
              </NavigationMenuLink>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
        <Link
          to="/auth"
          className={cn("ml-auto", buttonVariants({ size: "lg" }))}
        >
          Get Started
        </Link>
      </div>
    </header>
  );
}
