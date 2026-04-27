# TODO


- Viewer: box-drawing corner characters (┘, ┐, etc.) show 1px overshoot from adjacent │ and ─ lines due to xterm.js fractional cell width rendering — would need custom box-drawing renderer to fix
- Viewer: must clear WKWebView cache (`~/Library/WebKit/terminal-viewer` and `~/Library/Caches/terminal-viewer`) after rebuilding the Tauri binary, and must delete `src-tauri/target/release/build/terminal-viewer-*` before `cargo build` to force asset re-embedding
