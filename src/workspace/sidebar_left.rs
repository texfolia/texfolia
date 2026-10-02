use gpui_kit::component::{
    ActiveTheme, Icon, IconName, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    sidebar::{Sidebar, SidebarGroup, SidebarMenu, SidebarMenuItem},
    v_flex,
};
use gpui_kit::{App, IntoElement, ParentElement, Styled, div};

use super::{DOCUMENT_TITLE, FocusEditor, FocusPreview};

pub fn render(cx: &App) -> impl IntoElement + use<> {
    Sidebar::new("project-sidebar")
        .collapsible(false)
        .w_full()
        .h_full()
        .min_w_0()
        .min_h_0()
        .header(
            v_flex()
                .w_full()
                .min_w_0()
                .gap_2()
                .pb_3()
                .border_b_1()
                .border_color(cx.theme().sidebar_border)
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("PROJECT"),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .text_sm()
                        .font_medium()
                        .child(Icon::new(IconName::FolderOpen).small())
                        .child("Untitled"),
                ),
        )
        .child(
            SidebarGroup::new("Source").child(
                SidebarMenu::new().child(
                    SidebarMenuItem::new(DOCUMENT_TITLE)
                        .icon(Icon::new(IconName::FileText).small())
                        .active(true)
                        .accessibility_label(format!("{DOCUMENT_TITLE}, source buffer"))
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(FocusEditor), cx);
                        }),
                ),
            ),
        )
        .footer(
            v_flex()
                .w_full()
                .min_w_0()
                .gap_2()
                .pt_3()
                .border_t_1()
                .border_color(cx.theme().sidebar_border)
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("One source buffer"),
                )
                .child(
                    Button::new("project-focus-preview")
                        .ghost()
                        .small()
                        .w_full()
                        .icon(IconName::Eye)
                        .label("Focus preview")
                        .tooltip("Move focus to the document preview")
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(FocusPreview), cx);
                        }),
                ),
        )
}
