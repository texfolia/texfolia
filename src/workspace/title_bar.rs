use gpui_kit::component::{
    ActiveTheme, IconName, Selectable, Sizable, TitleBar,
    button::{Button, ButtonVariants},
    h_flex,
};
use gpui_kit::{App, InteractiveElement, IntoElement, MouseButton, ParentElement, Styled, div};

use super::{DOCUMENT_TITLE, ToggleCommandPalette, ToggleLeftSidebar, ToggleRightSidebar};

#[cfg(target_os = "macos")]
const COMMAND_SHORTCUT: &str = "⇧⌘P";
#[cfg(not(target_os = "macos"))]
const COMMAND_SHORTCUT: &str = "Ctrl+Shift+P";

pub fn render(left_open: bool, right_open: bool, cx: &App) -> impl IntoElement + use<> {
    let left_label = if left_open {
        "Hide project sidebar"
    } else {
        "Show project sidebar"
    };
    let right_label = if right_open {
        "Hide document outline"
    } else {
        "Show document outline"
    };

    // Keep TitleBar's native chrome padding and window-drag behavior intact.
    TitleBar::new().w_full().child(
        h_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .pr_2()
            .child(
                Button::new("toggle-project-sidebar")
                    .ghost()
                    .small()
                    .selected(left_open)
                    .toggled(left_open)
                    .icon(if left_open {
                        IconName::PanelLeftClose
                    } else {
                        IconName::PanelLeftOpen
                    })
                    .accessibility_label(left_label)
                    .tooltip(left_label)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(|_, window, cx| {
                        cx.stop_propagation();
                        window.dispatch_action(Box::new(ToggleLeftSidebar), cx);
                    }),
            )
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .justify_center()
                    .px_3()
                    .child(
                        Button::new("workspace-command-palette")
                            .ghost()
                            .small()
                            .min_w_0()
                            .max_w_full()
                            .overflow_hidden()
                            .border_1()
                            .border_color(cx.theme().title_bar_border)
                            .text_color(cx.theme().foreground)
                            .icon(IconName::Search)
                            .label(DOCUMENT_TITLE)
                            .accessibility_label("Open command palette")
                            .tooltip(format!("Open command palette ({COMMAND_SHORTCUT})"))
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .ml_2()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(COMMAND_SHORTCUT),
                            )
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(|_, window, cx| {
                                cx.stop_propagation();
                                window.dispatch_action(Box::new(ToggleCommandPalette), cx);
                            }),
                    ),
            )
            .child(
                Button::new("toggle-outline-sidebar")
                    .ghost()
                    .small()
                    .selected(right_open)
                    .toggled(right_open)
                    .icon(if right_open {
                        IconName::PanelRightClose
                    } else {
                        IconName::PanelRightOpen
                    })
                    .accessibility_label(right_label)
                    .tooltip(right_label)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(|_, window, cx| {
                        cx.stop_propagation();
                        window.dispatch_action(Box::new(ToggleRightSidebar), cx);
                    }),
            ),
    )
}
