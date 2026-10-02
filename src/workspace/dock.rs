use gpui_kit::component::{
    ActiveTheme, Icon, IconName, Sizable, StyledExt,
    button::Button,
    dock::{
        BasePanel, DockArea, DockLayout, DockSkin, Panel, PanelControl, PanelEvent, PanelId,
        PanelStyle, panel_handle,
    },
    h_flex, v_flex,
};
use gpui_kit::{
    App, AppContext, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement,
    IntoElement, MouseButton, ParentElement, Render, SharedString, Styled, Window, div, px,
};

use crate::editor::LatexEditor;

use super::{DOCUMENT_TITLE, FocusEditor};

pub struct DocumentDock {
    pub area: Entity<DockArea>,
    source: Entity<SourcePanel>,
    preview: Entity<PreviewPanel>,
}

impl DocumentDock {
    pub fn new(editor: Entity<LatexEditor>, window: &mut Window, cx: &mut App) -> Self {
        let source = cx.new(|_| SourcePanel { editor });
        let preview = cx.new(|cx| PreviewPanel {
            focus_handle: cx.focus_handle(),
        });
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
        area.update(cx, |area, cx| area.set_center(layout, window, cx));

        Self {
            area,
            source,
            preview,
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
    fn focus_handle(&self, cx: &App) -> FocusHandle {
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

struct PreviewPanel {
    focus_handle: FocusHandle,
}

impl EventEmitter<PanelEvent> for PreviewPanel {}

impl BasePanel for PreviewPanel {
    fn panel_name(&self) -> &'static str {
        "pdf-preview"
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

impl Panel for PreviewPanel {
    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .gap_2()
            .child(Icon::new(IconName::Eye).small())
            .child("PDF preview")
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }

    fn zoom_control(&self, _: &App) -> Option<PanelControl> {
        Some(PanelControl::Toolbar)
    }
}

impl Focusable for PreviewPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for PreviewPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .id("pdf-preview-panel")
            .track_focus(&self.focus_handle)
            .size_full()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .items_center()
            .justify_center()
            .p_6()
            .gap_4()
            .bg(cx.theme().muted)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| this.focus_handle.focus(window, cx)),
            )
            .child(
                Icon::new(IconName::FileText)
                    .size(px(36.))
                    .text_color(cx.theme().muted_foreground),
            )
            .child(
                v_flex()
                    .max_w(px(280.))
                    .gap_2()
                    .text_center()
                    .child(div().font_medium().child("Your document preview"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child("PDF compilation and rendering are not connected yet. Your LaTeX source is ready to edit."),
                    ),
            )
            .child(
                Button::new("preview-focus-source")
                    .small()
                    .outline()
                    .icon(IconName::FileText)
                    .label("Back to source")
                    .on_click(|_, window, cx| {
                        window.dispatch_action(Box::new(FocusEditor), cx);
                    }),
            )
    }
}
