use gpui_kit::component::{
    Icon, IconName, Sizable,
    dock::{
        BasePanel, DockArea, DockLayout, DockPlacement, DockSkin, Panel, PanelControl, PanelEvent,
        PanelId, PanelStyle, panel_handle,
    },
    h_flex,
};
use gpui_kit::{
    App, AppContext, Context, Entity, EventEmitter, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, Styled, Window, div, px,
};

use crate::editor::LatexEditor;
use crate::preview::{CompileEvent, CompileStatus, PreviewPanel, should_compile};
use crate::terminal::Terminal;

use super::DOCUMENT_TITLE;

pub struct DocumentDock {
    pub area: Entity<DockArea>,
    source: Entity<SourcePanel>,
    preview: Entity<PreviewPanel>,
    terminal: Entity<Terminal>,
}

impl DocumentDock {
    pub fn new(editor: Entity<LatexEditor>, window: &mut Window, cx: &mut App) -> Self {
        let source = cx.new(|_| SourcePanel { editor });
        let preview = cx.new(|cx| PreviewPanel::new(cx));
        let terminal = cx.new(|cx| Terminal::new(cx));
        let (area, skin) = DockSkin::dock_area("document-dock", None, window, cx);
        skin.set_panel_style(PanelStyle::TabBar, cx);
        skin.set_toggle_button_visible(false, cx);

        let layout = DockLayout::h_split()
            .child(
                DockLayout::tabs().panel_view(panel_handle(source.clone()), cx),
                None,
            )
            .child(
                DockLayout::tabs().panel_view(panel_handle(preview.clone()), cx),
                None,
            );
        area.update(cx, |area, cx| {
            area.set_center(layout, window, cx);
            area.set_dock(
                DockPlacement::Bottom,
                DockLayout::tabs().panel_view(panel_handle(terminal.clone()), cx),
                window,
                cx,
            );
            area.set_dock_size(DockPlacement::Bottom, px(180.), window, cx);
        });

        Self {
            area,
            source,
            preview,
            terminal,
        }
    }

    pub fn focus_editor(&self, window: &mut Window, cx: &mut App) {
        self.select(PanelId::from(self.source.entity_id()), window, cx);
        self.source.read(cx).focus_handle(cx).focus(window, cx);
    }

    pub fn focus_preview(&self, window: &mut Window, cx: &mut App) {
        self.select(PanelId::from(self.preview.entity_id()), window, cx);
        self.preview.read(cx).focus_handle(cx).focus(window, cx);
    }

    pub fn focus_terminal(&self, window: &mut Window, cx: &mut App) {
        self.area.update(cx, |area, cx| {
            area.set_zoomed_out(window, cx);
            if !area.is_dock_open(DockPlacement::Bottom) {
                area.toggle_dock(DockPlacement::Bottom, window, cx);
            }
            area.select_panel(PanelId::from(self.terminal.entity_id()), window, cx);
        });
        self.terminal.read(cx).focus_handle(cx).focus(window, cx);
    }

    pub fn compile_status(&self, cx: &App) -> CompileStatus {
        self.preview.read(cx).status()
    }

    pub fn preview(&self) -> &Entity<PreviewPanel> {
        &self.preview
    }

    pub fn compile(&self, source: String, window: &mut Window, cx: &mut App) {
        if !should_compile(CompileEvent::Manual) {
            return;
        }
        let terminal = self.terminal.clone();
        self.preview.update(cx, |preview, cx| {
            preview.start_compile(source, terminal, window, cx);
        });
    }

    pub fn compile_on_save(&self, source: String, window: &mut Window, cx: &mut App) {
        if !should_compile(CompileEvent::Save) {
            return;
        }
        let terminal = self.terminal.clone();
        self.preview.update(cx, |preview, cx| {
            preview.start_compile(source, terminal, window, cx);
        });
    }

    fn select(&self, panel: PanelId, window: &mut Window, cx: &mut App) {
        self.area.update(cx, |area, cx| {
            // A focus command must also reveal a panel hidden by another panel's zoom.
            area.set_zoomed_out(window, cx);
            area.select_panel(panel, window, cx);
        });
    }
}

struct SourcePanel {
    editor: Entity<LatexEditor>,
}

impl EventEmitter<PanelEvent> for SourcePanel {}

impl BasePanel for SourcePanel {
    fn panel_name(&self) -> &'static str {
        "latex-source"
    }

    fn set_zoomed(&mut self, zoomed: bool, window: &mut Window, cx: &mut Context<Self>) {
        if zoomed {
            self.focus_handle(cx).focus(window, cx);
        }
    }

    fn closable(&self, _: &App) -> bool {
        false
    }
}

impl Panel for SourcePanel {
    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .gap_2()
            .child(Icon::new(IconName::FileText).small())
            .child(DOCUMENT_TITLE)
    }

    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(DOCUMENT_TITLE.into())
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }

    fn zoom_control(&self, _: &App) -> Option<PanelControl> {
        Some(PanelControl::Toolbar)
    }
}

impl Focusable for SourcePanel {
    fn focus_handle(&self, cx: &App) -> gpui_kit::FocusHandle {
        self.editor.read(cx).focus_handle(cx)
    }
}

impl Render for SourcePanel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("latex-source-panel")
            .size_full()
            .min_w_0()
            .min_h_0()
            .child(self.editor.clone())
    }
}
