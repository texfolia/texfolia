use gpui_kit::component::{ActiveTheme, h_flex, status_bar::StatusBar};
use gpui_kit::{App, IntoElement, ParentElement, Styled, div, px};

pub fn render(stats: super::DocumentStats, cx: &App) -> impl IntoElement + use<> {
    let buffer_state = if stats.modified {
        "Modified"
    } else {
        "New buffer"
    };
    let state_color = if stats.modified {
        cx.theme().foreground
    } else {
        cx.theme().muted_foreground
    };
    let line_label = if stats.lines == 1 { "line" } else { "lines" };
    let word_label = if stats.words == 1 { "word" } else { "words" };

    StatusBar::new()
        .w_full()
        .min_w_0()
        .h(px(28.))
        .flex_shrink_0()
        .px_3()
        .text_color(cx.theme().muted_foreground)
        .left(
            h_flex()
                .gap_2()
                .child(div().size(px(5.)).rounded_full().bg(state_color))
                .child(div().text_color(state_color).child(buffer_state)),
        )
        .child(
            h_flex()
                .min_w_0()
                .gap_3()
                .child(format!("{} {line_label}", stats.lines))
                .child(format!("{} {word_label}", stats.words)),
        )
        .right("LaTeX")
        .right("UTF-8")
}
