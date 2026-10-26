use super::{SessionActions, SessionPhase};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum Status {
    #[default]
    Ready,
    Capturing,
    Error,
}

pub(super) enum Failure<T> {
    Stale,
    Accepted(Option<T>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExclusiveOperation {
    Update,
    Restart,
    Processing,
}

pub(super) struct Lifecycle<T> {
    next_epoch: u64,
    active_epoch: Option<u64>,
    initializing_epoch: Option<u64>,
    running: Option<T>,
    status: Status,
    error: Option<String>,
    exclusive_operation: Option<ExclusiveOperation>,
}

impl<T> Default for Lifecycle<T> {
    fn default() -> Self {
        Self {
            next_epoch: 0,
            active_epoch: None,
            initializing_epoch: None,
            running: None,
            status: Status::Ready,
            error: None,
            exclusive_operation: None,
        }
    }
}

impl<T> Lifecycle<T> {
    fn ensure_startable(&self, teardown_active: bool) -> Result<(), &'static str> {
        match self.exclusive_operation {
            Some(ExclusiveOperation::Update) => {
                return Err("正在下载或安装更新，无法开始转写");
            }
            Some(ExclusiveOperation::Restart) => return Err("应用正在重启，无法开始转写"),
            Some(ExclusiveOperation::Processing) => {
                return Err("正在处理资料，请等待完成后再开始转写")
            }
            None => {}
        }
        if teardown_active {
            return Err("会话仍在收尾，请等待末句与译文完成");
        }
        if self.active_epoch.is_some() || self.initializing_epoch.is_some() {
            return Err("会话正在启动或采集中");
        }
        Ok(())
    }

    pub(super) fn begin(&mut self) -> Result<u64, &'static str> {
        self.ensure_startable(false)?;
        self.next_epoch += 1;
        self.active_epoch = Some(self.next_epoch);
        self.initializing_epoch = self.active_epoch;
        self.status = Status::Ready;
        self.error = None;
        Ok(self.next_epoch)
    }

    pub(super) fn reserve_exclusive(
        &mut self,
        operation: ExclusiveOperation,
        teardown_active: bool,
    ) -> Result<(), &'static str> {
        match self.exclusive_operation {
            Some(ExclusiveOperation::Update) => return Err("正在下载或安装更新，请稍候"),
            Some(ExclusiveOperation::Restart) => return Err("应用正在重启，请稍候"),
            Some(ExclusiveOperation::Processing) => return Err("正在处理资料，请等待完成后再操作"),
            None => {}
        }
        if self.initializing_epoch.is_some() {
            return Err("会话仍在启动，请等待启动结束后再操作");
        }
        if self.active_epoch.is_some() {
            return Err("请先停止转写，再处理资料或更改应用状态");
        }
        if teardown_active {
            return Err("会话仍在收尾，请等待转写和翻译完成后再操作");
        }
        self.exclusive_operation = Some(operation);
        Ok(())
    }

    pub(super) fn release_exclusive(&mut self, operation: ExclusiveOperation) {
        if self.exclusive_operation == Some(operation) {
            self.exclusive_operation = None;
        }
    }

    pub(super) fn publish(&mut self, epoch: u64, running: T) -> Result<(), T> {
        if self.active_epoch != Some(epoch) {
            return Err(running);
        }
        self.running = Some(running);
        self.initializing_epoch = None;
        self.status = Status::Capturing;
        Ok(())
    }

    pub(super) fn fail(&mut self, epoch: u64, error: String) -> Failure<T> {
        if self.active_epoch != Some(epoch) {
            return Failure::Stale;
        }
        self.active_epoch = None;
        self.status = Status::Error;
        self.error = Some(error);
        Failure::Accepted(self.running.take())
    }

    pub(super) fn abort_start(&mut self, epoch: u64) -> bool {
        let initializing = self.initializing_epoch == Some(epoch);
        if initializing {
            self.initializing_epoch = None;
        }
        if self.active_epoch == Some(epoch) && self.running.is_none() {
            self.active_epoch = None;
        }
        initializing
    }

    pub(super) fn stop(&mut self) -> Option<T> {
        self.active_epoch = None;
        self.status = Status::Ready;
        self.error = None;
        self.running.take()
    }

    pub(super) fn status(&self) -> Status {
        self.status
    }

    pub(super) fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub(super) fn running(&self) -> Option<&T> {
        self.running.as_ref()
    }

    pub(super) fn view(&self, teardown_active: bool) -> (SessionPhase, SessionActions) {
        let phase = if teardown_active {
            SessionPhase::Finalizing
        } else if self.initializing_epoch.is_some() {
            SessionPhase::Preparing
        } else if self.exclusive_operation == Some(ExclusiveOperation::Processing) {
            SessionPhase::Processing
        } else {
            match self.status {
                Status::Ready => SessionPhase::Ready,
                Status::Capturing => SessionPhase::Capturing,
                Status::Error => SessionPhase::Error,
            }
        };
        let reason = if teardown_active {
            Some("正在整理末句与译文，请稍候")
        } else if self.initializing_epoch.is_some() {
            Some("正在准备识别与翻译，请等待启动完成")
        } else {
            self.ensure_startable(false).err()
        };
        let actions = SessionActions {
            can_start: self.ensure_startable(teardown_active).is_ok(),
            can_stop: self.running.is_some(),
            can_clear: self.ensure_clearable(teardown_active).is_ok(),
            can_export: !teardown_active
                && self.exclusive_operation != Some(ExclusiveOperation::Processing),
            reason: reason.map(str::to_owned),
        };
        (phase, actions)
    }

    pub(super) fn ensure_clearable(&self, teardown_active: bool) -> Result<(), &'static str> {
        if self.exclusive_operation == Some(ExclusiveOperation::Processing) {
            return Err("正在处理资料，暂时不能清空");
        }
        if self.initializing_epoch.is_some() {
            return Err("会话仍在启动，请等待启动结束后再清空");
        }
        if self.active_epoch.is_some() {
            return Err("请先停止转写，再清空记录");
        }
        if teardown_active {
            return Err("会话仍在收尾，请稍后再清空");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_and_actions_follow_preparation_capture_and_finalization() {
        let mut state = Lifecycle::<()>::default();
        let (phase, actions) = state.view(false);
        assert_eq!(phase, SessionPhase::Ready);
        assert!(actions.can_start && actions.can_clear && actions.can_export);
        assert!(!actions.can_stop);
        assert!(actions.reason.is_none());

        let epoch = state.begin().unwrap();
        let (phase, actions) = state.view(false);
        assert_eq!(state.status(), Status::Ready);
        assert_eq!(phase, SessionPhase::Preparing);
        assert!(!actions.can_start && !actions.can_stop && !actions.can_clear);
        assert!(actions.can_export, "准备期间仍可导出先前的定稿");
        assert!(actions.reason.is_some());

        state.publish(epoch, ()).unwrap();
        let (phase, actions) = state.view(false);
        assert_eq!(phase, SessionPhase::Capturing);
        assert!(actions.can_stop && actions.can_export);
        assert!(!actions.can_start && !actions.can_clear);

        assert!(state.stop().is_some());
        let (phase, actions) = state.view(true);
        assert_eq!(state.status(), Status::Ready);
        assert_eq!(phase, SessionPhase::Finalizing);
        assert!(
            !actions.can_start && !actions.can_stop && !actions.can_clear && !actions.can_export
        );

        let (phase, actions) = state.view(false);
        assert_eq!(phase, SessionPhase::Ready);
        assert!(actions.can_start && actions.can_clear && actions.can_export);
    }

    #[test]
    fn cancelled_preparation_remains_busy_until_initialization_exits() {
        let mut state = Lifecycle::<()>::default();
        let epoch = state.begin().unwrap();
        assert!(state.stop().is_none());
        assert_eq!(state.status(), Status::Ready);
        let (phase, actions) = state.view(false);
        assert_eq!(phase, SessionPhase::Preparing);
        assert!(!actions.can_start && !actions.can_stop && !actions.can_clear);
        assert!(state.abort_start(epoch));
        assert_eq!(state.view(false).0, SessionPhase::Ready);
        assert!(state.view(false).1.can_start);
    }

    #[test]
    fn failed_capture_is_finalizing_until_resources_are_released() {
        let mut state = Lifecycle::<()>::default();
        let epoch = state.begin().unwrap();
        state.publish(epoch, ()).unwrap();
        assert!(matches!(
            state.fail(epoch, "设备断开".into()),
            Failure::Accepted(Some(()))
        ));
        assert_eq!(state.status(), Status::Error);
        assert_eq!(state.view(true).0, SessionPhase::Finalizing);
        assert!(!state.view(true).1.can_start);
        let (phase, actions) = state.view(false);
        assert_eq!(phase, SessionPhase::Error);
        assert!(actions.can_start && actions.can_clear && actions.can_export);
        assert_eq!(state.error(), Some("设备断开"));
    }

    #[test]
    fn exclusive_actions_only_restrict_the_actions_the_backend_rejects() {
        for operation in [ExclusiveOperation::Update, ExclusiveOperation::Restart] {
            let mut state = Lifecycle::<()>::default();
            state.reserve_exclusive(operation, false).unwrap();
            let (phase, actions) = state.view(false);
            assert_eq!(phase, SessionPhase::Ready);
            assert!(!actions.can_start && !actions.can_stop);
            assert!(actions.can_clear && actions.can_export);
            assert!(actions.reason.is_some());
            state.release_exclusive(operation);
            assert!(state.view(false).1.can_start);
            assert!(state.view(false).1.reason.is_none());
        }
    }

    #[test]
    fn late_abort_and_failure_cannot_change_a_new_preparation_view() {
        let mut state = Lifecycle::<()>::default();
        let old = state.begin().unwrap();
        assert!(state.abort_start(old));
        let current = state.begin().unwrap();
        let expected = state.view(false);
        assert!(!state.abort_start(old));
        assert!(matches!(state.fail(old, "旧故障".into()), Failure::Stale));
        assert_eq!(state.view(false), expected);
        state.publish(current, ()).unwrap();
        assert_eq!(state.view(false).0, SessionPhase::Capturing);
    }

    #[test]
    fn failed_start_can_be_retried() {
        let mut state = Lifecycle::<&str>::default();
        let failed = state.begin().unwrap();
        state.abort_start(failed);
        let retry = state.begin().unwrap();
        state.publish(retry, "重试资源").unwrap();
        assert_eq!(state.running(), Some(&"重试资源"));
        assert_eq!(state.status(), Status::Capturing);
    }

    #[test]
    fn runtime_failure_returns_resources_once_and_allows_retry() {
        let mut state = Lifecycle::default();
        let epoch = state.begin().unwrap();
        state.publish(epoch, "音频与推理资源").unwrap();
        assert!(matches!(
            state.fail(epoch, "设备已断开".into()),
            Failure::Accepted(Some("音频与推理资源"))
        ));
        assert_eq!(state.status(), Status::Error);
        assert_eq!(state.error(), Some("设备已断开"));
        assert!(state.running().is_none());
        assert!(matches!(
            state.fail(epoch, "重复故障".into()),
            Failure::Stale
        ));

        let retry = state.begin().unwrap();
        state.publish(retry, "新设备").unwrap();
        assert_eq!(state.error(), None);
        assert_eq!(state.status(), Status::Capturing);
    }

    #[test]
    fn early_failure_cannot_be_overwritten_by_capture_publication() {
        let mut state = Lifecycle::default();
        let epoch = state.begin().unwrap();
        assert!(matches!(
            state.fail(epoch, "启动后立即断开".into()),
            Failure::Accepted(None)
        ));
        assert_eq!(
            state.publish(epoch, "必须释放的资源"),
            Err("必须释放的资源")
        );
        assert_eq!(state.status(), Status::Error);
    }

    #[test]
    fn old_failure_cannot_stop_a_new_session() {
        let mut state = Lifecycle::default();
        let old = state.begin().unwrap();
        state.publish(old, "旧设备").unwrap();
        assert_eq!(state.stop(), Some("旧设备"));
        let new = state.begin().unwrap();
        state.publish(new, "新设备").unwrap();
        assert!(matches!(state.fail(old, "迟到故障".into()), Failure::Stale));
        assert_eq!(state.running(), Some(&"新设备"));
        assert_eq!(state.status(), Status::Capturing);
    }

    #[test]
    fn stop_during_start_rejects_late_resources() {
        let mut state = Lifecycle::default();
        let epoch = state.begin().unwrap();
        assert!(state.stop().is_none());
        assert_eq!(state.publish(epoch, "已取消的资源"), Err("已取消的资源"));
        assert_eq!(state.status(), Status::Ready);
        assert!(state.begin().is_err());
        assert!(state.ensure_clearable(false).is_err());
        state.abort_start(epoch);
        assert!(state.ensure_clearable(false).is_ok());
        assert!(state.begin().is_ok());
    }

    #[test]
    fn clear_guard_rejects_capturing_and_stopping_sessions() {
        let mut state = Lifecycle::default();
        let epoch = state.begin().unwrap();
        state.publish(epoch, "采集资源").unwrap();
        assert!(state.ensure_clearable(false).is_err());
        state.stop();
        assert!(state.ensure_clearable(true).is_err());
        assert!(state.ensure_clearable(false).is_ok());
    }

    #[test]
    fn update_and_restart_reject_starting_capturing_and_unfinished_teardown() {
        for operation in [ExclusiveOperation::Update, ExclusiveOperation::Restart] {
            let mut state = Lifecycle::default();
            let epoch = state.begin().unwrap();
            assert!(state.reserve_exclusive(operation, false).is_err());
            state.publish(epoch, "采集资源").unwrap();
            assert!(state.reserve_exclusive(operation, false).is_err());
            assert_eq!(state.stop(), Some("采集资源"));
            assert_eq!(state.status(), Status::Ready);
            assert!(state.reserve_exclusive(operation, true).is_err());
            assert!(state.reserve_exclusive(operation, false).is_ok());
        }
    }

    #[test]
    fn cancelling_a_start_does_not_allow_updates_until_initialization_exits() {
        let mut state = Lifecycle::<()>::default();
        let epoch = state.begin().unwrap();
        state.stop();
        assert!(state
            .reserve_exclusive(ExclusiveOperation::Update, false)
            .is_err());
        assert!(state
            .reserve_exclusive(ExclusiveOperation::Restart, false)
            .is_err());
        state.abort_start(epoch);
        assert!(state
            .reserve_exclusive(ExclusiveOperation::Update, false)
            .is_ok());
    }

    #[test]
    fn update_and_restart_reservations_block_every_later_start() {
        for operation in [ExclusiveOperation::Update, ExclusiveOperation::Restart] {
            let mut state = Lifecycle::<()>::default();
            state.reserve_exclusive(operation, false).unwrap();
            assert!(state.begin().is_err());
            assert!(state
                .reserve_exclusive(ExclusiveOperation::Update, false)
                .is_err());
            assert!(state
                .reserve_exclusive(ExclusiveOperation::Restart, false)
                .is_err());
            state.stop();
            assert!(state.begin().is_err());
            state.release_exclusive(operation);
            assert!(state.begin().is_ok());
        }
    }

    #[test]
    fn simultaneous_session_and_update_requests_have_only_one_winner() {
        use std::sync::{Arc, Barrier, Mutex};

        for _ in 0..32 {
            let state = Arc::new(Mutex::new(Lifecycle::<()>::default()));
            let ready = Arc::new(Barrier::new(3));
            let attempted = Arc::new(Barrier::new(3));
            let threads: Vec<_> = [false, true]
                .into_iter()
                .map(|update| {
                    let state = state.clone();
                    let ready = ready.clone();
                    let attempted = attempted.clone();
                    std::thread::spawn(move || {
                        ready.wait();
                        let accepted = {
                            let mut lifecycle = state.lock().unwrap();
                            if update {
                                lifecycle
                                    .reserve_exclusive(ExclusiveOperation::Update, false)
                                    .is_ok()
                            } else {
                                lifecycle.begin().is_ok()
                            }
                        };
                        attempted.wait();
                        accepted
                    })
                })
                .collect();
            ready.wait();
            attempted.wait();
            let accepted = threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .filter(|accepted| *accepted)
                .count();
            assert_eq!(accepted, 1);
        }
    }
}
