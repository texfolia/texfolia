mod command_palette;
mod dock;
mod sidebar_left;
mod sidebar_right;
mod status_bar;
mod title_bar;

use gpui_kit::component::{
    ActiveTheme,
    input::{InputEvent, Position},
    resizable::{ResizableState, h_resizable, resizable_panel},
    v_flex,
};
use gpui_kit::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    KeyBinding, ParentElement, Pixels, Render, Styled, Subscription, Window, actions, div,
    prelude::FluentBuilder, px,
};

use crate::editor::LatexEditor;

use dock::DocumentDock;

const DOCUMENT_TITLE: &str = "Untitled.tex";

// The palette binding is global so it also works while a dialog owns focus.
#[cfg(target_os = "macos")]
const PALETTE_SHORTCUT: &str = "cmd-shift-p";
#[cfg(not(target_os = "macos"))]
const PALETTE_SHORTCUT: &str = "ctrl-shift-p";

#[cfg(target_os = "macos")]
const WORKSPACE_SHORTCUTS: [&str; 4] = ["cmd-b", "cmd-alt-b", "cmd-1", "cmd-2"];
#[cfg(not(target_os = "macos"))]
const WORKSPACE_SHORTCUTS: [&str; 4] = ["ctrl-b", "ctrl-alt-b", "ctrl-1", "ctrl-2"];

actions!(
    workspace,
    [
        ToggleCommandPalette,
        ToggleLeftSidebar,
        ToggleRightSidebar,
        FocusEditor,
        FocusPreview,
    ]
);

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new(PALETTE_SHORTCUT, ToggleCommandPalette, None),
        KeyBinding::new(WORKSPACE_SHORTCUTS[0], ToggleLeftSidebar, Some("Workspace")),
        KeyBinding::new(
            WORKSPACE_SHORTCUTS[1],
            ToggleRightSidebar,
            Some("Workspace"),
        ),
        KeyBinding::new(WORKSPACE_SHORTCUTS[2], FocusEditor, Some("Workspace")),
        KeyBinding::new(WORKSPACE_SHORTCUTS[3], FocusPreview, Some("Workspace")),
    ]);
}

#[derive(Clone, Copy)]
enum WorkspaceCommand {
    ToggleLeftSidebar,
    ToggleRightSidebar,
    FocusEditor,
    FocusPreview,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DocumentSection {
    title: String,
    level: usize,
    line: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DocumentStats {
    lines: usize,
    words: usize,
    modified: bool,
}

impl DocumentStats {
    fn from_source(source: &str) -> Self {
        Self {
            lines: source.bytes().filter(|byte| *byte == b'\n').count() + 1,
            words: source.split_whitespace().count(),
            modified: !source.is_empty(),
        }
    }
}

pub struct Workspace {
    focus_handle: FocusHandle,
    editor: Entity<LatexEditor>,
    dock: DocumentDock,
    left_open: bool,
    right_open: bool,
    sections: Vec<DocumentSection>,
    stats: DocumentStats,
    column_states: [Entity<ResizableState>; 4],
    _editor_subscription: Subscription,
    _focus_lost_subscription: Subscription,
}

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| LatexEditor::new("", window, cx));
        let state = editor.read(cx).state().clone();
        let dock = DocumentDock::new(editor.clone(), window, cx);
        let subscription = cx.subscribe(&state, |this, state, event, cx| {
            if matches!(event, InputEvent::Change) {
                let source = state.read(cx).value();
                this.sections = document_outline(&source);
                this.stats = DocumentStats::from_source(&source);
                cx.notify();
            }
        });
        let column_states = std::array::from_fn(|_| cx.new(|_| ResizableState::default()));
        let focus_lost_subscription = cx.on_focus_lost(window, |this, window, cx| {
            if let Some(target) = window.focus_lost_restore_target(cx)
                && this.focus_handle.contains(&target, window)
            {
                target.focus(window, cx);
                window.defer(cx, |window, _| window.refresh());
            }
        });
        dock.focus_editor(window, cx);

        Self {
            focus_handle: cx.focus_handle(),
            editor,
            dock,
            left_open: true,
            right_open: true,
            sections: Vec::new(),
            stats: DocumentStats::from_source(""),
            column_states,
            _editor_subscription: subscription,
            _focus_lost_subscription: focus_lost_subscription,
        }
    }

    fn run_command(
        &mut self,
        command: WorkspaceCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match command {
            WorkspaceCommand::ToggleLeftSidebar => self.left_open = !self.left_open,
            WorkspaceCommand::ToggleRightSidebar => self.right_open = !self.right_open,
            WorkspaceCommand::FocusEditor => self.dock.focus_editor(window, cx),
            WorkspaceCommand::FocusPreview => self.dock.focus_preview(window, cx),
        }
        cx.notify();
    }

    fn go_to_line(&mut self, line: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.dock.focus_editor(window, cx);
        let position = Position::new(line.saturating_sub(1).min(self.stats.lines - 1) as u32, 0);
        let state = self.editor.read(cx).state().clone();
        state.update(cx, |state, cx| {
            state.set_cursor_position(position, window, cx)
        });
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = title_bar::render(self.left_open, self.right_open, cx);
        let left = sidebar_left::render(cx);
        let right = sidebar_right::render(&self.sections, cx);
        let status = status_bar::render(self.stats, cx);
        // Each visibility layout has stable panel indices and independent resize state.
        let layout = usize::from(self.left_open) | (usize::from(self.right_open) << 1);
        let columns = h_resizable(("workspace-columns", layout))
            .with_state(&self.column_states[layout])
            .when(self.left_open, |columns| {
                columns.child(
                    resizable_panel()
                        .flex_none()
                        .size(px(220.))
                        .size_range(px(180.)..px(340.))
                        .child(left),
                )
            })
            .child(
                resizable_panel().size_range(px(320.)..Pixels::MAX).child(
                    div()
                        .size_full()
                        .min_w_0()
                        .min_h_0()
                        .child(self.dock.area.clone()),
                ),
            )
            .when(self.right_open, |columns| {
                columns.child(
                    resizable_panel()
                        .flex_none()
                        .size(px(240.))
                        .size_range(px(200.)..px(380.))
                        .child(right),
                )
            });

        v_flex()
            .id("latex-workspace")
            .key_context("Workspace")
            .track_focus(&self.focus_handle)
            .size_full()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .on_action(cx.listener(|_, _: &ToggleCommandPalette, window, cx| {
                command_palette::toggle(window, cx);
            }))
            .on_action(cx.listener(|this, _: &ToggleLeftSidebar, window, cx| {
                this.run_command(WorkspaceCommand::ToggleLeftSidebar, window, cx);
            }))
            .on_action(cx.listener(|this, _: &ToggleRightSidebar, window, cx| {
                this.run_command(WorkspaceCommand::ToggleRightSidebar, window, cx);
            }))
            .on_action(cx.listener(|this, _: &FocusEditor, window, cx| {
                this.run_command(WorkspaceCommand::FocusEditor, window, cx);
            }))
            .on_action(cx.listener(|this, _: &FocusPreview, window, cx| {
                this.run_command(WorkspaceCommand::FocusPreview, window, cx);
            }))
            .child(title)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .overflow_hidden()
                    .child(columns),
            )
            .child(status)
    }
}

/// A lightweight outline of section declarations at the start of source lines,
/// not a TeX parser: macro expansion and verbatim environments are not evaluated.
fn document_outline(source: &str) -> Vec<DocumentSection> {
    const SECTIONS: [(&str, usize); 7] = [
        ("\\part", 0),
        ("\\chapter", 1),
        ("\\section", 2),
        ("\\subsection", 3),
        ("\\subsubsection", 4),
        ("\\paragraph", 5),
        ("\\subparagraph", 6),
    ];

    source
        .lines()
        .enumerate()
        .filter_map(|(line, text)| {
            let text = without_comment(text).trim_start();
            SECTIONS.iter().find_map(|(command, level)| {
                let mut rest = text.strip_prefix(command)?.trim_start();
                if let Some(unstarred) = rest.strip_prefix('*') {
                    rest = unstarred.trim_start();
                }
                if rest.starts_with('[') {
                    rest = delimited(rest, '[', ']')?.1.trim_start();
                }
                let (title, _) = delimited(rest, '{', '}')?;
                let title = title.trim();
                if title.is_empty() {
                    return None;
                }
                Some(DocumentSection {
                    title: title.to_owned(),
                    level: *level,
                    line: line + 1,
                })
            })
        })
        .collect()
}

fn without_comment(text: &str) -> &str {
    let mut escaped = false;
    for (index, character) in text.char_indices() {
        if escaped {
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '%' {
            return &text[..index];
        }
    }
    text
}

fn delimited(text: &str, open: char, close: char) -> Option<(&str, &str)> {
    let text = text.strip_prefix(open)?;
    let mut depth = 1;
    let mut escaped = false;
    for (index, character) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
        } else if character == open {
            depth += 1;
        } else if character == close {
            depth -= 1;
            if depth == 0 {
                return Some((&text[..index], &text[index + character.len_utf8()..]));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{DocumentSection, DocumentStats, document_outline, without_comment};

    #[test]
    fn empty_buffer_has_one_line_and_no_words() {
        assert_eq!(
            DocumentStats::from_source(""),
            DocumentStats {
                lines: 1,
                words: 0,
                modified: false,
            }
        );
    }

    #[test]
    fn source_stats_include_trailing_empty_lines_and_unicode_words() {
        assert_eq!(
            DocumentStats::from_source("Hello κόσμε\n\n"),
            DocumentStats {
                lines: 3,
                words: 2,
                modified: true,
            }
        );
    }

    #[test]
    fn outline_tracks_hierarchy_and_source_lines() {
        let source = "\\documentclass{article}\n  \\section{Introduction}\n\\subsection*{Background}\n\\subsubsection[Short]{A {nested} title}\n";
        assert_eq!(
            document_outline(source),
            vec![
                DocumentSection {
                    title: "Introduction".into(),
                    level: 2,
                    line: 2,
                },
                DocumentSection {
                    title: "Background".into(),
                    level: 3,
                    line: 3,
                },
                DocumentSection {
                    title: "A {nested} title".into(),
                    level: 4,
                    line: 4,
                },
            ]
        );
    }

    #[test]
    fn outline_ignores_comments_and_incomplete_or_unrelated_commands() {
        let source = "% \\section{Hidden}\n\\sectionname{Not a section}\n\\section{Incomplete\n\\section{}\n\\section{Visible} % comment";
        assert_eq!(document_outline(source).len(), 1);
        assert_eq!(document_outline(source)[0].title, "Visible");
        assert_eq!(document_outline(source)[0].line, 5);
    }

    #[test]
    fn outline_preserves_escaped_percent_braces_and_unicode_titles() {
        let source = "\\section{100\\% \\{proof\\} — résumé}";
        assert_eq!(
            document_outline(source)[0].title,
            "100\\% \\{proof\\} — résumé"
        );
        assert_eq!(without_comment(r"text \\% comment"), r"text \\");
    }
}
