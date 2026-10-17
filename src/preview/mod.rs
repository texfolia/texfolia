mod compile;
mod pdf;

use std::sync::Arc;

use gpui_kit::component::{
    ActiveTheme, Disableable, Icon, IconName, Sizable, StyledExt, WindowExt,
    button::{Button, ButtonVariants},
    dialog::{DialogClose, DialogFooter},
    dock::{BasePanel, Panel, PanelControl, PanelEvent},
    h_flex, scroll::ScrollableElement as _, spinner::Spinner, v_flex,
};
use gpui_kit::{
    App, AppContext, AsyncApp, Context, Entity, EventEmitter, FocusHandle, Focusable, Image,
    InteractiveElement, IntoElement, MouseButton, ParentElement, Render, SharedString, Styled,
    StyledImage, Task, WeakEntity, Window, div, img, px,
};

use crate::terminal::Terminal;
use crate::workspace::FocusEditor;

pub use compile::{CompileEvent, TectonicBackend, should_compile};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompileStatus {
    Idle,
    Compiling,
    Succeeded,
    Failed,
}

enum PreviewState {
    Empty,
    Compiling,
    Ready { pages: Vec<Arc<Image>> },
    Failed { message: SharedString },
}

pub struct PreviewPanel {
    focus_handle: FocusHandle,
    state: PreviewState,
    generation: u64,
    preferred_backend: Option<TectonicBackend>,
    _compile_task: Option<Task<()>>,
}

impl PreviewPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            state: PreviewState::Empty,
            generation: 0,
            preferred_backend: None,
            _compile_task: None,
        }
    }

    pub fn status(&self) -> CompileStatus {
        match self.state {
            PreviewState::Empty => CompileStatus::Idle,
            PreviewState::Compiling => CompileStatus::Compiling,
            PreviewState::Ready { .. } => CompileStatus::Succeeded,
            PreviewState::Failed { .. } => CompileStatus::Failed,
        }
    }

    /// Start a Tectonic compile, prompting to install or use Docker when needed.
    pub fn start_compile(
        &mut self,
        source: String,
        terminal: Entity<Terminal>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match compile::resolve_backend(self.preferred_backend.as_ref()) {
            Some(backend) => self.run_compile(source, terminal, backend, cx),
            None => show_tectonic_setup_dialog(source, terminal, window, cx),
        }
    }

    fn run_compile(
        &mut self,
        source: String,
        terminal: Entity<Terminal>,
        backend: TectonicBackend,
        cx: &mut Context<Self>,
    ) {
        self.preferred_backend = Some(backend.clone());
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;
        self.state = PreviewState::Compiling;
        cx.notify();

        terminal.update(cx, |terminal, cx| {
            terminal.clear(cx);
            terminal.append("Compiling with Tectonic…", cx);
        });

        let (tx, rx) = async_channel::unbounded();
        let terminal_weak = terminal.downgrade();

        cx.background_spawn(async move {
            compile::compile_latex(&source, &backend, tx);
        })
        .detach();

        self._compile_task = Some(cx.spawn(async move |this, cx| {
            while let Ok(message) = rx.recv().await {
                match message {
                    compile::CompileMessage::Log(line) => {
                        let _ = terminal_weak.update(cx, |terminal, cx| {
                            terminal.append(line, cx);
                        });
                    }
                    compile::CompileMessage::Done(result) => {
                        finish_compile(this, terminal_weak, generation, result, cx).await;
                        break;
                    }
                }
            }
        }));
    }

    fn begin_install_then_compile(
        &mut self,
        source: String,
        terminal: Entity<Terminal>,
        cx: &mut Context<Self>,
    ) {
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;
        self.state = PreviewState::Compiling;
        cx.notify();

        terminal.update(cx, |terminal, cx| {
            terminal.clear(cx);
            terminal.append("Tectonic not found — installing…", cx);
        });

        let (tx, rx) = async_channel::unbounded();
        let terminal_weak = terminal.downgrade();

        cx.background_spawn(async move {
            match compile::install_tectonic(&tx) {
                Ok(path) => {
                    let backend = TectonicBackend::Cli(path);
                    compile::compile_latex(&source, &backend, tx);
                }
                Err(err) => {
                    let _ = tx.send_blocking(compile::CompileMessage::Done(Err(err)));
                }
            }
        })
        .detach();

        self._compile_task = Some(cx.spawn(async move |this, cx| {
            while let Ok(message) = rx.recv().await {
                match message {
                    compile::CompileMessage::Log(line) => {
                        let _ = terminal_weak.update(cx, |terminal, cx| {
                            terminal.append(line, cx);
                        });
                    }
                    compile::CompileMessage::Done(result) => {
                        if result.is_ok() {
                            let _ = this.update(cx, |this, _| {
                                if let Some(path) = compile::find_tectonic() {
                                    this.preferred_backend = Some(TectonicBackend::Cli(path));
                                }
                            });
                        }
                        finish_compile(this, terminal_weak, generation, result, cx).await;
                        break;
                    }
                }
            }
        }));
    }
}

fn show_tectonic_setup_dialog(
    source: String,
    terminal: Entity<Terminal>,
    window: &mut Window,
    cx: &mut Context<PreviewPanel>,
) {
    let preview = cx.weak_entity();
    let docker_ok = compile::docker_available();

    terminal.update(cx, |terminal, cx| {
        terminal.append("Tectonic was not found on this machine.", cx);
    });

    window.open_dialog(cx, move |dialog, _, cx| {
        let preview_docker = preview.clone();
        let preview_install = preview.clone();
        let source_install = source.clone();
        let source_docker = source.clone();
        let terminal_install = terminal.clone();
        let terminal_docker = terminal.clone();
        let muted = cx.theme().muted_foreground;

        dialog
            .title("Tectonic required")
            .child(
                v_flex()
                    .gap_2()
                    .child(div().child("Texfolia compiles LaTeX with the Tectonic CLI."))
                    .child(
                        div()
                            .text_sm()
                            .text_color(muted)
                            .child(
                                "Install with Homebrew, or run Tectonic in Docker (Docker Desktop may need to be started).",
                            ),
                    ),
            )
            .footer(
                DialogFooter::new()
                    .child(DialogClose::new().trigger(|button| button.label("Cancel")))
                    .child(
                        Button::new("tectonic-docker")
                            .outline()
                            .label(if docker_ok {
                                "Use Docker"
                            } else {
                                "Docker unavailable"
                            })
                            .disabled(!docker_ok)
                            .on_click(move |_, window, cx| {
                                window.close_dialog(cx);
                                let _ = preview_docker.update(cx, |this, cx| {
                                    this.run_compile(
                                        source_docker.clone(),
                                        terminal_docker.clone(),
                                        TectonicBackend::Docker,
                                        cx,
                                    );
                                });
                            }),
                    )
                    .child(
                        Button::new("tectonic-install")
                            .primary()
                            .label("Install Tectonic")
                            .on_click(move |_, window, cx| {
                                window.close_dialog(cx);
                                let _ = preview_install.update(cx, |this, cx| {
                                    this.begin_install_then_compile(
                                        source_install.clone(),
                                        terminal_install.clone(),
                                        cx,
                                    );
                                });
                            }),
                    ),
            )
    });
}

async fn finish_compile(
    preview: WeakEntity<PreviewPanel>,
    terminal: WeakEntity<Terminal>,
    generation: u64,
    result: Result<Vec<u8>, String>,
    cx: &mut AsyncApp,
) {
    match result {
        Ok(pdf_bytes) => {
            let size = pdf_bytes.len();
            let rendered = cx
                .background_spawn(async move { pdf::render_pdf_pages(pdf_bytes, 900) })
                .await;
            let _ = preview.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match rendered {
                    Ok(pages) => {
                        let page_count = pages.len();
                        this.state = PreviewState::Ready { pages };
                        let _ = terminal.update(cx, |terminal, cx| {
                            terminal.append(
                                format!(
                                    "Done — {page_count} page{}, {size} bytes",
                                    if page_count == 1 { "" } else { "s" }
                                ),
                                cx,
                            );
                        });
                    }
                    Err(err) => {
                        this.state = PreviewState::Failed {
                            message: err.clone().into(),
                        };
                        let _ = terminal.update(cx, |terminal, cx| {
                            terminal.append(format!("PDF render failed: {err}"), cx);
                        });
                    }
                }
                cx.notify();
            });
        }
        Err(err) => {
            let _ = preview.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.state = PreviewState::Failed {
                    message: err.clone().into(),
                };
                let _ = terminal.update(cx, |terminal, cx| {
                    terminal.append(format!("Compilation failed: {err}"), cx);
                });
                cx.notify();
            });
        }
    }
}

impl EventEmitter<PanelEvent> for PreviewPanel {}

impl BasePanel for PreviewPanel {
    fn panel_name(&self) -> &'static str {
        "pdf-preview"
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
        let body = match &self.state {
            PreviewState::Empty => empty_state(cx).into_any_element(),
            PreviewState::Compiling => compiling_state(cx).into_any_element(),
            PreviewState::Ready { pages } => pages_state(pages).into_any_element(),
            PreviewState::Failed { message } => failed_state(message, cx).into_any_element(),
        };

        v_flex()
            .id("pdf-preview-panel")
            .track_focus(&self.focus_handle)
            .size_full()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .bg(cx.theme().muted)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| this.focus_handle.focus(window, cx)),
            )
            .child(body)
    }
}

fn empty_state(cx: &App) -> impl IntoElement + use<> {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .p_6()
        .gap_4()
        .child(
            Icon::new(IconName::FileText)
                .size(px(36.))
                .text_color(cx.theme().muted_foreground),
        )
        .child(
            v_flex()
                .max_w(px(320.))
                .gap_2()
                .text_center()
                .child(div().font_medium().child("Your document preview"))
                .child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(
                            "Compile with ⌘⏎ / Ctrl+Enter, or save to refresh the PDF. Tectonic can be installed or run via Docker when missing.",
                        ),
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

fn compiling_state(cx: &App) -> impl IntoElement + use<> {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap_3()
        .child(Spinner::new().color(cx.theme().muted_foreground))
        .child(
            div()
                .text_sm()
                .text_color(cx.theme().muted_foreground)
                .child("Compiling…"),
        )
}

fn failed_state(message: &SharedString, cx: &App) -> impl IntoElement + use<> {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .p_6()
        .gap_3()
        .child(
            Icon::new(IconName::CircleAlert)
                .size(px(32.))
                .text_color(cx.theme().danger),
        )
        .child(div().font_medium().child("Compilation failed"))
        .child(
            div()
                .max_w(px(360.))
                .text_sm()
                .text_center()
                .text_color(cx.theme().muted_foreground)
                .child(message.clone()),
        )
        .child(
            div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child("See the Compilation panel for details."),
        )
}

fn pages_state(pages: &[Arc<Image>]) -> impl IntoElement + use<> {
    div()
        .id("pdf-pages")
        .size_full()
        .min_h_0()
        .overflow_y_scrollbar()
        .p_4()
        .child(
            v_flex()
                .w_full()
                .items_center()
                .gap_4()
                .children(pages.iter().enumerate().map(|(index, page)| {
                    div()
                        .id(("pdf-page", index))
                        .w_full()
                        .max_w(px(720.))
                        .child(
                            img(page.clone())
                                .object_fit(gpui_kit::ObjectFit::Contain)
                                .w_full(),
                        )
                })),
        )
}
