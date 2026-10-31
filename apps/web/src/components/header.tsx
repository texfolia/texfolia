import { Link } from "@tanstack/react-router";

import { buttonVariants } from "#/components/ui/button";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "#/components/ui/navigation-menu";

export function Header() {
  return (
    <header className="flex w-full p-4">
      <Link to="/" className="flex items-center gap-2 font-serif">
        Texfolia
      </Link>
      <NavigationMenu>
        <NavigationMenuList>
          <NavigationMenuItem>
            <NavigationMenuTrigger>Item One</NavigationMenuTrigger>
            <NavigationMenuContent>
              <NavigationMenuLink>Link</NavigationMenuLink>
            </NavigationMenuContent>
          </NavigationMenuItem>
        </NavigationMenuList>
      </NavigationMenu>
      <Link to="/auth" className={buttonVariants({})}>
        Get Started
      </Link>
    </header>
  );
}
