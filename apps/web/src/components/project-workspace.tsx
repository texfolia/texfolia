import "dockview-react/dist/styles/dockview.css";
import { ClientOnly, Link } from "@tanstack/react-router";
import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  themeLight,
} from "dockview-react";
import { ArrowLeft } from "lucide-react";
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { Editor } from "#/components/editor";
import {
  ProjectFileTree,
  type ProjectNode,
} from "#/components/project-file-tree";
import { Button } from "#/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "#/components/ui/sidebar";
import { Toolbar, ToolbarButton } from "#/components/ui/toolbar";

type FileState = { value: string; savedValue: string };
type FilePanelParams = { node: ProjectNode; preview: boolean };
type Workspace = {
  drafts: Map<string, FileState>;
  keepOpen: (id: string) => void;
  change: (id: string, value: string, saved?: boolean) => void;
};
const WorkspaceContext = createContext<Workspace | null>(null);
function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("Missing project workspace");
  return workspace;
}
const PdfViewer = lazy(() => import("#/components/pdf"));

function FileEditor({ params }: IDockviewPanelProps<FilePanelParams>) {
  const workspace = useWorkspace();
  const draft = workspace.drafts.get(params.node.id);
  if (params.node.kind === "binary")
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Preview is not available for this file type.
      </p>
    );
  return (
    <Editor
      filename={params.node.name}
      defaultValue={draft?.value ?? ""}
      defaultSavedValue={draft?.savedValue ?? ""}
      allowOpenFile={false}
      onChange={(value) => workspace.change(params.node.id, value)}
      onSave={(value) => workspace.change(params.node.id, value, true)}
    />
  );
}

function FileTab(props: IDockviewPanelHeaderProps<FilePanelParams>) {
  const workspace = useWorkspace();
  return (
    <div
      className="h-full"
      style={{ fontStyle: props.params.preview ? "italic" : "normal" }}
    >
      <DockviewDefaultTab
        {...props}
        onDoubleClick={() => workspace.keepOpen(props.api.id)}
      />
    </div>
  );
}

const components = {
  editor: FileEditor,
  pdf: () => (
    <div className="h-full overflow-auto">
      <Suspense fallback={<p className="p-4">Loading PDF viewer…</p>}>
        <PdfViewer />
      </Suspense>
    </div>
  ),
};
const tabComponents = { file: FileTab };

export function ProjectWorkspace({
  name,
  nodes,
}: {
  name: string;
  nodes: ProjectNode[];
}) {
  const api = useRef<DockviewApi | null>(null);
  const previewId = useRef<string | null>(null);
  const drafts = useRef(new Map<string, FileState>());
  const subscriptions = useRef<Array<{ dispose: () => void }>>([]);
  const [activeId, setActiveId] = useState<string>();
  const [ready, setReady] = useState(false);

  useEffect(
    () => () => {
      subscriptions.current.forEach((subscription) => subscription.dispose());
    },
    [],
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        [...drafts.current.values()].some(
          (draft) => draft.value !== draft.savedValue,
        )
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  function keepOpen(id: string) {
    if (previewId.current !== id) return;
    previewId.current = null;
    api.current?.getPanel(id)?.api.updateParameters({ preview: false });
  }

  function change(id: string, value: string, saved = false) {
    const previous = drafts.current.get(id) ?? { value: "", savedValue: "" };
    const savedValue = saved ? value : previous.savedValue;
    drafts.current.set(id, { value, savedValue });
    keepOpen(id);
    const panel = api.current?.getPanel(id);
    const node = nodes.find((node) => node.id === id);
    if (node)
      panel?.api.setTitle(`${node.name}${value !== savedValue ? " ●" : ""}`);
  }

  function openFile(node: ProjectNode, permanent: boolean) {
    const dock = api.current;
    if (!dock) return;
    const existing = dock.getPanel(node.id);
    if (existing) {
      if (permanent) keepOpen(node.id);
      existing.api.setActive();
      return;
    }
    const preview = previewId.current
      ? dock.getPanel(previewId.current)
      : undefined;
    const reference =
      preview ?? dock.panels.find((panel) => panel.id !== "pdf");
    const draft = drafts.current.get(node.id);
    dock.addPanel<FilePanelParams>({
      id: node.id,
      component: "editor",
      tabComponent: "file",
      title: `${node.name}${draft && draft.value !== draft.savedValue ? " ●" : ""}`,
      params: {
        node,
        preview: !permanent,
      },
      renderer: "always",
      position: reference
        ? { referencePanel: reference.id, direction: "within" }
        : dock.getPanel("pdf")
          ? { referencePanel: "pdf", direction: "left" }
          : undefined,
    });
    if (!permanent) {
      previewId.current = node.id;
      if (preview) dock.removePanel(preview);
    }
  }

  function onReady({ api: dock }: DockviewReadyEvent) {
    api.current = dock;
    subscriptions.current.forEach((subscription) => subscription.dispose());
    subscriptions.current = [
      dock.onDidActivePanelChange(({ panel }) => {
        if (panel?.id !== "pdf") setActiveId(panel?.id);
      }),
      dock.onDidRemovePanel((panel) => {
        if (previewId.current === panel.id) previewId.current = null;
      }),
    ];
    const first =
      nodes.find((node) => node.kind === "text" && node.name === "main.tex") ??
      nodes.find((node) => node.kind === "text");
    if (first) openFile(first, true);
    dock.addPanel({
      id: "pdf",
      component: "pdf",
      title: "PDF Preview",
      position: first
        ? { referencePanel: first.id, direction: "right" }
        : undefined,
    });
    if (first) dock.getPanel(first.id)?.api.setActive();
    setReady(true);
  }

  return (
    <WorkspaceContext.Provider
      value={{ drafts: drafts.current, keepOpen, change }}
    >
      <SidebarProvider className="h-svh overflow-hidden">
        <Sidebar variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to="/projects" />}>
                  <ArrowLeft />
                  Back to Projects
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel title={name}>{name}</SidebarGroupLabel>
              <SidebarGroupContent aria-busy={!ready}>
                <ProjectFileTree
                  nodes={nodes}
                  activeId={activeId}
                  onOpen={openFile}
                />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <header className="flex shrink-0 items-center gap-2 border-b p-2">
            <SidebarTrigger />
            <Toolbar>
              <ToolbarButton render={<Button />}>Compile</ToolbarButton>
            </Toolbar>
          </header>
          <div className="min-h-0 flex-1">
            <ClientOnly>
              <DockviewReact
                className="size-full"
                theme={themeLight}
                components={components}
                tabComponents={tabComponents}
                onReady={onReady}
              />
            </ClientOnly>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </WorkspaceContext.Provider>
  );
}
