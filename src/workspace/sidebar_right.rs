use gpui_kit::component::{
    ActiveTheme, Side, StyledExt, h_flex,
    sidebar::{Sidebar, SidebarMenuItem},
    v_flex,
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::{App, Context, IntoElement, ParentElement, StyleRefinement, Styled, div, px};

pub fn render(
    sections: &[super::DocumentSection],
    cx: &mut Context<super::Workspace>,
) -> impl IntoElement + use<> {
    let base_level = sections
        .iter()
        .map(|section| section.level)
        .min()
        .unwrap_or(0);
    let items: Vec<_> = sections
        .iter()
        .map(|section| {
            let line = section.line;
            let depth = section.level.saturating_sub(base_level).min(4);

            SidebarMenuItem::new(section.title.clone())
                .pl(px(8. + depth as f32 * 12.))
                .label_style(StyleRefinement::default().min_w_0().truncate())
                .accessibility_label(format!("{}, line {line}", section.title))
                .suffix(move |_, cx: &mut App| {
                    div()
                        .flex_shrink_0()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(format!("L{line}"))
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.go_to_line(line, window, cx);
                }))
        })
        .collect();

    Sidebar::new("outline-sidebar")
        .side(Side::Right)
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
                    h_flex()
                        .w_full()
                        .justify_between()
                        .child(div().text_sm().font_medium().child("Outline"))
                        .child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child(sections.len().to_string()),
                        ),
                )
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(super::DOCUMENT_TITLE),
                )
                .when(sections.is_empty(), |header| {
                    header.child(
                        div()
                            .pt_4()
                            .pb_2()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child("Add a section to see your outline."),
                    )
                }),
        )
        .children(items)
        .footer(
            v_flex()
                .w_full()
                .min_w_0()
                .gap_1()
                .pt_3()
                .border_t_1()
                .border_color(cx.theme().sidebar_border)
                .child(div().text_xs().font_medium().child("TeX tooling"))
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("Compilation is not connected."),
                ),
        )
}
