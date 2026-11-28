import {
  Component,
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useState,
} from "react";

import { Button } from "#/components/ui/button";

class LoadError extends Error {}

/**
 * A component whose code loads when it first renders. Unlike a bare `lazy`, code
 * that cannot be loaded, such as while offline, does not take down the page
 * around it: the panel offers to try again.
 */
export function lazyPanel<Props extends object>(
  name: string,
  load: () => Promise<ComponentType<Props>>,
) {
  const create = () =>
    lazy(async () => {
      try {
        return { default: await load() };
      } catch (cause) {
        // React keeps a rejected `lazy` rejected.
        current = create();
        throw new LoadError(`${name} could not be loaded`, { cause });
      }
    });
  // Shared, so that a panel which closes and opens again does not suspend.
  let current: ComponentType<Props> = create();

  return function LazyPanel(props: Props) {
    const [{ Panel, attempt }, setPanel] = useState({
      Panel: current,
      attempt: 0,
    });
    return (
      <LoadBoundary
        key={attempt}
        name={name}
        onRetry={() => setPanel({ Panel: current, attempt: attempt + 1 })}
      >
        <Suspense
          fallback={
            <p role="status" className="sr-only">
              Loading {name}…
            </p>
          }
        >
          <Panel {...props} />
        </Suspense>
      </LoadBoundary>
    );
  };
}

class LoadBoundary extends Component<
  { name: string; onRetry: () => void; children: ReactNode },
  { error: unknown }
> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (!(error instanceof LoadError)) throw error;
    return (
      <div className="flex flex-wrap items-center gap-2 p-3 text-sm">
        <p role="alert" className="text-destructive">
          {this.props.name} could not be loaded. Check your connection and try
          again.
        </p>
        <Button size="sm" variant="outline" onClick={this.props.onRetry}>
          Try again
        </Button>
      </div>
    );
  }
}
