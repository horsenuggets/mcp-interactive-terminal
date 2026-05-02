use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::env;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;

async fn stream_pty_data(app: AppHandle, socket_path: String) {
    let mut stream = match UnixStream::connect(&socket_path).await {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit("pty-error", format!("Connection failed: {}", e));
            return;
        }
    };

    let _ = app.emit("pty-connected", &socket_path);

    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) => {
                let _ = app.emit("pty-closed", ());
                app.exit(0);
                break;
            }
            Ok(n) => {
                let encoded = BASE64.encode(&buf[..n]);
                let _ = app.emit("pty-data", encoded);
            }
            Err(e) => {
                let _ = app.emit("pty-error", format!("Read error: {}", e));
                app.exit(1);
                break;
            }
        }
    }
}

extern "C" {
    fn sel_registerName(name: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    fn objc_getClass(name: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    fn objc_msgSend(obj: *mut std::ffi::c_void, sel: *mut std::ffi::c_void, ...) -> *mut std::ffi::c_void;
}

#[cfg(target_os = "macos")]
fn order_window_back(window: &tauri::WebviewWindow) {
    type Id = *mut std::ffi::c_void;
    type Sel = *mut std::ffi::c_void;
    type MsgSend1IdVoid = unsafe extern "C" fn(Id, Sel, Id);
    if let Ok(ns_window) = window.ns_window() {
        unsafe {
            let msg1_id_void: MsgSend1IdVoid =
                std::mem::transmute(objc_msgSend as *const ());
            let sel = sel_registerName(b"orderBack:\0".as_ptr() as *const _);
            let nil: Id = std::ptr::null_mut();
            msg1_id_void(ns_window as *mut _, sel, nil);
        }
    }
}

/// True if this process was launched from inside a macOS `.app` bundle.
///
/// AppKit reads the menu bar app name from `CFBundleName` for bundled launches,
/// which `tauri.conf.json`'s `productName` already populates correctly. We only
/// need to override the name when the raw binary is invoked directly.
#[cfg(target_os = "macos")]
fn is_bundled_macos_launch() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_owned()))
        .map(|s| s.contains(".app/Contents/MacOS/"))
        .unwrap_or(false)
}

/// Override the macOS application name shown in the menu bar.
///
/// When the binary is launched directly (not as a `.app` bundle), AppKit derives the
/// menu bar app name from the executable filename — which would show `terminal-viewer`.
/// `[NSRunningApplication currentApplication] localizedName` is backed by the process
/// name, so updating `[[NSProcessInfo processInfo] setProcessName:]` early — before
/// AppKit constructs its main menu — propagates "Terminal Viewer" to the menu bar.
#[cfg(target_os = "macos")]
fn set_macos_app_name(name: &str) {
    use std::ffi::CString;
    type Id = *mut std::ffi::c_void;
    type Sel = *mut std::ffi::c_void;
    // On Apple Silicon, calling the variadic `objc_msgSend` directly is undefined
    // behavior — each call site must cast to a function pointer that exactly
    // matches the selector's real signature, including its return type.
    type MsgSend0 = unsafe extern "C" fn(Id, Sel) -> Id;
    type MsgSend1Ptr = unsafe extern "C" fn(Id, Sel, *const std::ffi::c_char) -> Id;
    type MsgSend1IdVoid = unsafe extern "C" fn(Id, Sel, Id);
    unsafe {
        let msg0: MsgSend0 = std::mem::transmute(objc_msgSend as *const ());
        let msg1_ptr: MsgSend1Ptr = std::mem::transmute(objc_msgSend as *const ());
        let msg1_id_void: MsgSend1IdVoid = std::mem::transmute(objc_msgSend as *const ());

        let ns_process_info_cls = objc_getClass(b"NSProcessInfo\0".as_ptr() as *const _);
        if ns_process_info_cls.is_null() {
            return;
        }
        let sel_process_info = sel_registerName(b"processInfo\0".as_ptr() as *const _);
        let process_info = msg0(ns_process_info_cls, sel_process_info);
        if process_info.is_null() {
            return;
        }

        let ns_string_cls = objc_getClass(b"NSString\0".as_ptr() as *const _);
        if ns_string_cls.is_null() {
            return;
        }
        let sel_with_utf8 = sel_registerName(b"stringWithUTF8String:\0".as_ptr() as *const _);
        let name_c = match CString::new(name) {
            Ok(c) => c,
            Err(_) => return,
        };
        let ns_name = msg1_ptr(ns_string_cls, sel_with_utf8, name_c.as_ptr());

        let sel_set = sel_registerName(b"setProcessName:\0".as_ptr() as *const _);
        msg1_id_void(process_info, sel_set, ns_name);
    }
}

/// Parse a flag value like --cols=120 or --cols 120
fn parse_flag(args: &[String], flag: &str) -> Option<String> {
    for (i, arg) in args.iter().enumerate() {
        if let Some(val) = arg.strip_prefix(&format!("{}=", flag)) {
            return Some(val.to_string());
        }
        if arg == flag {
            return args.get(i + 1).cloned();
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Bundled launches read the app name from CFBundleName (set by Tauri's
    // productName), so the override is only needed for direct binary launches.
    #[cfg(target_os = "macos")]
    if !is_bundled_macos_launch() {
        set_macos_app_name("Terminal Viewer");
    }

    let args: Vec<String> = env::args().collect();
    let foreground = args.iter().any(|a| a == "--foreground" || a == "-f");
    let cols: u32 = parse_flag(&args, "--cols").and_then(|v| v.parse().ok()).unwrap_or(80);
    let rows: u32 = parse_flag(&args, "--rows").and_then(|v| v.parse().ok()).unwrap_or(24);
    let socket_path = args.iter()
        .find(|a| !a.starts_with('-') && a.as_str() != args[0] && a.parse::<u32>().is_err())
        .cloned()
        .or_else(|| env::var("MCP_TERMINAL_SOCKET").ok());

    tauri::Builder::default()
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Inject terminal dimensions into the webview as a global variable.
            // This runs before the page JS executes, so it's always available.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(&format!(
                    "window.__TERMINAL_CONFIG__ = {{ cols: {}, rows: {} }};",
                    cols, rows
                ));
            }

            // Show window when JS signals ready (after resize)
            let handle_show = app.handle().clone();
            let fg = foreground;
            app.handle().listen("viewer-ready", move |_| {
                let h = handle_show.clone();
                let _ = handle_show.run_on_main_thread(move || {
                    if let Some(window) = h.get_webview_window("main") {
                        if fg {
                            let _ = window.show();
                            let _ = window.set_focus();
                        } else {
                            #[cfg(target_os = "macos")]
                            order_window_back(&window);
                            #[cfg(not(target_os = "macos"))]
                            let _ = window.show();
                        }
                    }
                });
            });

            if let Some(path) = socket_path.clone() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    stream_pty_data(handle, path).await;
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
