use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WindowEvent};

use crate::monitor;

pub const MAIN_LABEL: &str = "main";

#[derive(Debug, Default)]
pub struct LifecycleState {
    quitting: AtomicBool,
}

impl LifecycleState {
    fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
fn set_dock_visible(app: &AppHandle, visible: bool) {
    let policy = if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    if let Err(e) = app.set_activation_policy(policy) {
        tracing::error!(visible, "切换激活策略失败：{e}");
    }
}

pub fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    set_dock_visible(app, true);

    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        tracing::error!("找不到主窗口（label={MAIN_LABEL}）");
        return;
    };

    let _ = window.unminimize();
    if let Err(e) = window.show().and_then(|_| window.set_focus()) {
        tracing::error!("唤回主窗口失败：{e}");
    } else {
        monitor::on_window_shown(app);
    }
}

pub fn quit_app(app: &AppHandle) {
    let state = app.state::<LifecycleState>();
    if state.is_quitting() {
        return;
    }
    state.mark_quitting();
    if let Some(media) = app.try_state::<crate::media::MediaState>() {
        media.cancel_all();
    }
    app.state::<crate::session::SessionState>()
        .request_shutdown();
    let quit_app = app.clone();
    if let Err(error) = crate::commands::enqueue_session(move || {
        if let Err(error) = crate::session::finish_for_exit(&quit_app) {
            tracing::warn!("退出收尾未完成：{error}");
        }
        if let Some(workspace) = quit_app.try_state::<crate::workspace::WorkspaceState>() {
            workspace.flush();
        }
        quit_app.exit(0);
    }) {
        tracing::error!("无法安排退出收尾：{error}");
        if let Some(workspace) = app.try_state::<crate::workspace::WorkspaceState>() {
            workspace.flush();
        }
        app.exit(0);
    }
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    let quitting = window
        .app_handle()
        .try_state::<LifecycleState>()
        .map(|s| s.is_quitting())
        .unwrap_or(false);

    if quitting {
        return;
    }

    api.prevent_close();

    if let Err(e) = window.hide() {
        tracing::error!(label = window.label(), "隐藏窗口失败：{e}");
    } else {
        if window.label() == MAIN_LABEL {
            monitor::on_window_hidden(window.app_handle());
        }
        #[cfg(target_os = "macos")]
        {
            if window.label() == MAIN_LABEL {
                set_dock_visible(window.app_handle(), false);
            }
        }
        tracing::debug!(label = window.label(), "窗口已收进托盘");
    }
}

pub fn on_run_event(app: &AppHandle, event: &tauri::RunEvent) -> bool {
    if let tauri::RunEvent::ExitRequested { .. } = event {
        let quitting = app
            .try_state::<LifecycleState>()
            .map(|s| s.is_quitting())
            .unwrap_or(false);
        if !quitting {
            tracing::debug!("拦下退出请求（后台常驻中）");
            return true;
        }
    }
    false
}
