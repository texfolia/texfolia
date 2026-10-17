use gpui_kit::component::{
    ActiveTheme, IconName, WindowExt,
    command::{Command, CommandItem, CommandState},
    h_flex,
};
use gpui_kit::{AppContext, Context, InteractiveElement, ParentElement, Styled, Window, div, px};

use super::{ToggleCommandPalette, Workspace, WorkspaceCommand};

const COMMANDS: [(WorkspaceCommand, &str, IconName, &str); 7] = [
    (
        WorkspaceCommand::ToggleLeftSidebar,
        "Toggle project sidebar",
        IconName::PanelLeft,
        "files explorer left",
    ),
    (
        WorkspaceCommand::ToggleRightSidebar,
        "Toggle document outline",
        IconName::PanelRight,
        "sections right sidebar",
    ),
    (
        WorkspaceCommand::FocusEditor,
        "Focus LaTeX source",
        IconName::FileText,
        "editor document write",
    ),
    (
        WorkspaceCommand::FocusPreview,
        "Focus PDF preview",
        IconName::Eye,
        "document output",
    ),
    (
        WorkspaceCommand::FocusTerminal,
        "Focus compilation log",
        IconName::SquareTerminal,
        "terminal build output logs",
    ),
    (
        WorkspaceCommand::SaveDocument,
        "Save document",
        IconName::FileText,
        "save checkpoint compile",
    ),
    (
        WorkspaceCommand::CompileDocument,
        "Compile with Tectonic",
        IconName::Play,
        "build pdf latex tectonic",
    ),
];

pub fn toggle(window: &mut Window, cx: &mut Context<Workspace>) {
    if window.has_active_dialog(cx) {
        window.close_dialog(cx);
        return;
    }

    let state = cx.new(|cx| CommandState::new(window, cx));
    let palette_state = state.clone();
    let workspace = cx.weak_entity();

    window.open_dialog(cx, move |dialog, _, _| {
        let workspace = workspace.clone();
        dialog
            .title("Command palette")
            .width(px(520.))
            .margin_top(px(72.))
            .close_button(false)
            .child(
                div()
                    .on_action(|_: &ToggleCommandPalette, window, cx| {
                        window.close_dialog(cx);
                    })
                    .child(
                        Command::new(&palette_state)
                            .bordered(false)
                            .placeholder("Search workspace commands…")
                            .items(COMMANDS.iter().map(|(_, label, icon, keywords)| {
                                CommandItem::new()
                                    .label(*label)
                                    .icon(icon.clone())
                                    .keywords(keywords.split_whitespace())
                            }))
                            .on_confirm(move |index, window, cx| {
                                let Some(command) =
                                    COMMANDS.get(index.row).map(|(command, ..)| *command)
                                else {
                                    return;
                                };
                                // Dialog content is outside the workspace's action tree.
                                // Close first to restore focus, then call the owner directly.
                                window.close_dialog(cx);
                                let _ = workspace.update(cx, |this, cx| {
                                    this.run_command(command, window, cx);
                                });
                            })
                            .footer(|_, _, cx| {
                                h_flex()
                                    .justify_between()
                                    .px_3()
                                    .py_2()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child("↑ ↓ Navigate    ↵ Run")
                                    .child("Esc Close")
                            }),
                    ),
            )
    });
    state.update(cx, |state, cx| state.focus(window, cx));
}
