use gpui_kit::component::{
    highlighter::{GrammarConfig, LanguageRegistry},
    input::{
        AutoClosingPair, BracketPair, Editor, EditorState, SyntaxContext,
        language_config::LanguageConfig, set_language_config,
    },
};
use gpui_kit::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, IntoElement, ParentElement, Render,
    SharedString, Styled, Window, div,
};

const LANGUAGE: &str = "latex";

fn language_config() -> LanguageConfig {
    LanguageConfig::default()
        .brackets([BracketPair::new("{", "}"), BracketPair::new("(", ")")])
        .auto_closing_pairs([
            AutoClosingPair::new("{", "}").not_in([SyntaxContext::String, SyntaxContext::Comment]),
            AutoClosingPair::new("(", ")").not_in([SyntaxContext::String, SyntaxContext::Comment]),
        ])
        .auto_close_before(";:.,=}])>")
}

/// An embeddable LaTeX source editor, independent of the workspace and preview.
///
/// Initialize `gpui_kit` before constructing this view. Without a registered
/// LaTeX grammar, source is unhighlighted and syntax-context exclusions are
/// unavailable; pairing, indentation, line numbers, and search still work.
pub struct LatexEditor {
    state: Entity<EditorState>,
}

impl LatexEditor {
    pub fn new(
        source: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let registry = LanguageRegistry::singleton();
        if registry.language(LANGUAGE).is_none() {
            // Preserve the LaTeX identity instead of falling back to "text",
            // which would apply these editing rules to plain-text editors too.
            registry.register(
                LANGUAGE,
                &GrammarConfig {
                    name: LANGUAGE.into(),
                },
            );
        }
        set_language_config(LANGUAGE, language_config(), cx);

        let state = cx.new(|cx| {
            EditorState::new(window, cx)
                .language(LANGUAGE)
                .default_value(source)
                .auto_close(true)
                .smart_indent(true)
        });

        Self { state }
    }

    /// Access the buffer to read or replace its value and subscribe to input events.
    pub fn state(&self) -> &Entity<EditorState> {
        &self.state
    }
}

impl Focusable for LatexEditor {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.state.read(cx).focus_handle(cx)
    }
}

impl Render for LatexEditor {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().min_w_0().min_h_0().child(
            Editor::new(&self.state)
                .size_full()
                .bordered(false)
                .aria_label("LaTeX source"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structural_pairs_match_latex_configuration() {
        assert_eq!(
            language_config().brackets,
            vec![BracketPair::new("{", "}"), BracketPair::new("(", ")")]
        );
    }

    #[test]
    fn auto_closing_excludes_strings_and_comments_without_pairing_quotes() {
        let config = language_config();
        let pairs = config.auto_closing_pairs.unwrap();

        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0].open.as_ref(), "{");
        assert_eq!(pairs[0].close.as_ref(), "}");
        assert_eq!(pairs[1].open.as_ref(), "(");
        assert_eq!(pairs[1].close.as_ref(), ")");
        for pair in pairs {
            assert_eq!(
                pair.not_in,
                vec![SyntaxContext::String, SyntaxContext::Comment]
            );
        }
        assert_eq!(config.auto_close_before.as_ref(), ";:.,=}])>");
    }
}
