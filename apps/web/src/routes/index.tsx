import { createFileRoute, Link } from "@tanstack/react-router";

import { Page } from "#/components/page";
import { pageHead } from "#/lib/head";
import { linkButton } from "#/lib/link-button";
import { appPath } from "#/lib/urls";

export const Route = createFileRoute("/")({
  head: () => pageHead({ title: "Space for your next great paper | Texfolia" }),
  component: Home,
});

const sampleSource = `\\documentclass{article}
\\usepackage{amsmath}

\\title{A study of small things}
\\author{A curious mind}

\\begin{document}
\\maketitle

\\section{The question}
Every discovery begins with
something worth asking.

\\[ E = mc^2 \\]
\\end{document}`;

const features = [
  {
    title: "Your source. Your workspace.",
    body: "Keep LaTeX, references, and figures together. Edit your source alongside the PDF and download your files when you need them.",
  },
  {
    title: "Better, together.",
    body: "Share a project with readers or editors. Work on the same documents in real time, without passing files back and forth.",
  },
  {
    title: "Room to change your mind.",
    body: "Compare document versions, name the milestones, and restore an earlier draft when you need a fresh start.",
  },
];

function Home() {
  return (
    <Page>
      <main id="main-content">
        <section className="mx-auto grid max-w-7xl gap-8 px-6 pt-16 pb-14 sm:px-8 sm:pt-24 lg:grid-cols-[1.3fr_1fr] lg:items-end lg:gap-16 lg:pb-20">
          <h1 className="max-w-3xl font-serif text-6xl leading-[1.02] tracking-[-0.035em] text-balance sm:text-8xl lg:text-[6rem]">
            Good ideas
            <br />
            deserve a<br />
            <span className="italic">great paper.</span>
          </h1>
          <div className="max-w-md lg:pb-2">
            <p className="text-muted-foreground text-lg leading-relaxed sm:text-xl">
              A focused LaTeX workspace for the work that matters. Write,
              collaborate, and compile your next paper, right in your browser.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href={appPath("/login")}
                className={linkButton({ size: "lg" })}
              >
                Start writing
                <span aria-hidden="true">→</span>
              </a>
              <Link
                to="/templates"
                className={linkButton({ variant: "outline", size: "lg" })}
              >
                Find a template
              </Link>
            </div>
          </div>
        </section>
        <section
          aria-label="An illustrative LaTeX workspace"
          className="bg-muted/50 border-y px-4 py-8 sm:px-8 sm:py-14"
        >
          <div className="bg-background mx-auto max-w-6xl overflow-hidden border">
            <div className="flex items-center justify-between border-b px-4 py-3 text-xs">
              <span className="font-medium">A study of small things</span>
              <span className="text-muted-foreground">
                Illustrative workspace
              </span>
            </div>
            <div className="grid min-h-80 md:grid-cols-[1fr_1fr_160px]">
              <div className="text-muted-foreground overflow-hidden border-b p-5 font-mono text-xs leading-7 sm:p-8 sm:text-sm md:border-r md:border-b-0">
                <div className="text-foreground mb-5 flex items-center gap-2 font-sans text-xs">
                  main.tex
                </div>
                <pre>{sampleSource}</pre>
              </div>
              <div className="bg-muted p-6 sm:p-10">
                <article className="mx-auto min-h-96 max-w-sm bg-white px-7 py-12 font-serif text-[#242424] shadow-sm sm:px-10">
                  <h2 className="text-center text-2xl leading-tight">
                    A study of small things
                  </h2>
                  <p className="mt-4 text-center text-xs">A curious mind</p>
                  <h3 className="mt-12 text-lg font-bold">
                    1&nbsp; The question
                  </h3>
                  <p className="mt-4 text-sm leading-6">
                    Every discovery begins with something worth asking.
                  </p>
                  <p className="mt-10 text-center text-2xl italic">E = mc²</p>
                  <p className="mt-16 text-center text-xs">1</p>
                </article>
              </div>
              <div className="hidden border-l text-xs md:block">
                <p className="border-b px-3 py-2 font-medium">Files</p>
                <p className="px-3 py-2">My paper</p>
                <p className="bg-muted px-3 py-2">main.tex</p>
              </div>
            </div>
          </div>
        </section>
        <section className="mx-auto grid max-w-7xl gap-12 px-6 py-20 sm:px-8 lg:grid-cols-[1fr_1.2fr] lg:gap-24 lg:py-28">
          <h2 className="max-w-md font-serif text-4xl leading-tight tracking-tight sm:text-5xl">
            From the first line
            <br />
            to the final draft.
          </h2>
          <div className="divide-y">
            {features.map((feature) => (
              <div key={feature.title} className="py-7 first:pt-0 last:pb-0">
                <h3 className="text-lg font-medium">{feature.title}</h3>
                <p className="text-muted-foreground mt-2 max-w-lg leading-relaxed">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </section>
        <section className="bg-muted/40 border-t px-6 py-16 text-center sm:py-24">
          <h2 className="font-serif text-4xl tracking-tight sm:text-6xl">
            What will you write next?
          </h2>
          <p className="text-muted-foreground mt-5">
            Start with a blank page or make a template your own.
          </p>
          <a
            href={appPath("/projects")}
            className={linkButton({ size: "lg", className: "mt-8" })}
          >
            Open your workspace
            <span aria-hidden="true">→</span>
          </a>
        </section>
      </main>
    </Page>
  );
}
