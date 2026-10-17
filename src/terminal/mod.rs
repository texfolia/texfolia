use gpui_kit::base::SelectableText;
use gpui_kit::component::{
    ActiveTheme, Icon, IconName, Sizable,
    dock::{BasePanel, Panel, PanelControl, PanelEvent},
    h_flex, scroll::ScrollableElement as _, v_flex,
};
use gpui_kit::{
    App, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, Styled, Window, div,
};

/// Append-only compilation log shown in the bottom dock.
pub struct Terminal {
    focus_handle: FocusHandle,
    lines: Vec<SharedString>,
}

impl Terminal {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            lines: Vec::new(),
        }
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.lines.clear();
        cx.notify();
    }

    pub fn append(&mut self, line: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.lines.push(line.into());
        cx.notify();
    }
}

impl EventEmitter<PanelEvent> for Terminal {}

impl BasePanel for Terminal {
    fn panel_name(&self) -> &'static str {
        "compilation-terminal"
    }

    fn set_zoomed(&mut self, zoomed: bool, window: &mut Window, cx: &mut Context<Self>) {
        if zoomed {
            self.focus_handle.focus(window, cx);
        }
    }

    fn closable(&self, _: &App) -> bool {
        false
    }
}

impl Panel for Terminal {
    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .gap_2()
            .child(Icon::new(IconName::SquareTerminal).small())
            .child("Compilation")
    }

    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some("Compilation".into())
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }

    fn zoom_control(&self, _: &App) -> Option<PanelControl> {
        Some(PanelControl::Toolbar)
    }
}

impl Focusable for Terminal {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Terminal {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let empty = self.lines.is_empty();
        let body: SharedString = if empty {
            "Compilation output will appear here.".into()
        } else {
            self.lines
                .iter()
                .map(|line| line.as_ref())
                .collect::<Vec<_>>()
                .join("\n")
                .into()
        };
        v_flex()
            .id("compilation-terminal")
            .track_focus(&self.focus_handle)
            .size_full()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .bg(cx.theme().background)
            .child(
                div()
                    .id("compilation-log")
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .px_3()
                    .py_2()
                    .font_family("ui-monospace, SFMono-Regular, Menlo, monospace")
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .overflow_y_scrollbar()
                    .child(SelectableText::new(
                        if empty {
                            "compilation-log-empty"
                        } else {
                            "compilation-log-body"
                        },
                        body,
                    )),
            )
    }
}
