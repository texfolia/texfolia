import { Button } from "@texfolia/ui/button";

import { useWorkspace } from "#/providers/workspace-provider";

export function WorkspaceProblems() {
  const { allProblems, reveal } = useWorkspace();
  return (
    <section
      aria-label="LaTeX problems"
      className="h-full overflow-auto p-3 text-sm"
    >
      {allProblems.length ? (
        <ul className="space-y-1">
          {allProblems.map((problem, index) => (
            <li key={`${problem.path}:${problem.line}:${index}`}>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start gap-3 text-left whitespace-normal"
                onClick={() => reveal(problem.path, problem.line)}
              >
                <span
                  className={
                    problem.severity === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {problem.path}:{problem.line}
                </span>
                {problem.message}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No problems.</p>
      )}
    </section>
  );
}
