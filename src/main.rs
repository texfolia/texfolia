pub mod editor;
pub mod workspace;

use gpui_kit::component::TitleBar;
use gpui_kit::*;
use workspace::Workspace;

fn main() {
    application().with_assets(assets::Assets).run(move |cx| {
        init(cx);
        workspace::init(cx);

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(1280.), px(800.)),
                cx,
            ))),
            window_min_size: Some(size(px(960.), px(640.))),
            ..TitleBar::window_options()
        };
        open_window(options, cx, |window, cx| {
            cx.new(|cx| Workspace::new(window, cx))
        })
        .expect("Failed to open window");
    });
}
