//! Bounded inference task queue that coalesces NOT-YET-RUN tasks only.
//!
//! One pending slot per (identity, horizon, direction). A newer feature snapshot for a slot that
//! is still waiting replaces the older one in place (it keeps its queue position, so a busy key
//! cannot starve the others); a task already taken by a worker is never touched. Feature folding
//! happens before a task exists and is never dropped here -- only the inference request is.

use std::collections::{HashMap, VecDeque};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use crate::contract::Direction;
use crate::features::KeyId;

#[derive(Debug, Clone)]
pub struct Task {
    pub task_id: u64,
    pub key: KeyId,
    pub horizon_minutes: u32,
    pub direction: Direction,
    pub features: Vec<f64>,
    /// features::CATEGORY_COLUMNS' values.
    pub categories: Vec<String>,
    pub input_watermark: u64,
    pub generation: u64,
    pub market_cutoff_ns: i64,
    pub stream_id: String,
    pub epoch: u64,
    pub config_version: u64,
    pub enqueued_at_ns: i64,
    pub expires_at_ns: i64,
}

pub type SlotId = (KeyId, u32, Direction);

impl Task {
    pub fn slot(&self) -> SlotId {
        (self.key.clone(), self.horizon_minutes, self.direction)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Pushed {
    Queued,
    Coalesced,
    /// Queue at capacity and the slot had nothing pending: the request is refused. The features
    /// it would have used are already folded; the next event for the key asks again.
    RejectedFull,
    Closed,
}

#[derive(Default)]
struct Inner {
    order: VecDeque<SlotId>,
    pending: HashMap<SlotId, Task>,
    closed: bool,
}

pub struct TaskQueue {
    inner: Mutex<Inner>,
    ready: Condvar,
    capacity: Mutex<usize>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct QueueCounts {
    pub depth: usize,
}

impl TaskQueue {
    pub fn new(capacity: usize) -> Self {
        Self { inner: Mutex::new(Inner::default()), ready: Condvar::new(), capacity: Mutex::new(capacity.max(1)) }
    }

    pub fn set_capacity(&self, capacity: usize) {
        *self.capacity.lock().unwrap() = capacity.max(1);
    }

    pub fn push(&self, task: Task) -> Pushed {
        let capacity = *self.capacity.lock().unwrap();
        let mut inner = self.inner.lock().unwrap();
        if inner.closed {
            return Pushed::Closed;
        }
        let slot = task.slot();
        if let Some(existing) = inner.pending.get_mut(&slot) {
            if task.input_watermark >= existing.input_watermark || task.config_version != existing.config_version || task.epoch != existing.epoch {
                *existing = task;
            }
            return Pushed::Coalesced;
        }
        if inner.pending.len() >= capacity {
            return Pushed::RejectedFull;
        }
        inner.order.push_back(slot.clone());
        inner.pending.insert(slot, task);
        drop(inner);
        self.ready.notify_one();
        Pushed::Queued
    }

    /// Next task, or None after `timeout` / when closed.
    pub fn pop(&self, timeout: Duration) -> Option<Task> {
        let mut inner = self.inner.lock().unwrap();
        loop {
            while let Some(slot) = inner.order.pop_front() {
                if let Some(task) = inner.pending.remove(&slot) {
                    return Some(task);
                }
            }
            if inner.closed {
                return None;
            }
            let (guard, result) = self.ready.wait_timeout(inner, timeout).unwrap();
            inner = guard;
            if result.timed_out() && inner.order.is_empty() {
                return None;
            }
        }
    }

    /// Drop pending tasks the predicate rejects (rollover, reset, config change). Returns how many.
    pub fn retain(&self, mut keep: impl FnMut(&Task) -> bool) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.pending.len();
        inner.pending.retain(|_, task| keep(task));
        let Inner { order, pending, .. } = &mut *inner;
        order.retain(|slot| pending.contains_key(slot));
        before - inner.pending.len()
    }

    pub fn close(&self) {
        self.inner.lock().unwrap().closed = true;
        self.ready.notify_all();
    }

    pub fn counts(&self) -> QueueCounts {
        QueueCounts { depth: self.inner.lock().unwrap().pending.len() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(code: &str, watermark: u64) -> Task {
        Task {
            task_id: watermark,
            key: KeyId { source: "shioaji".into(), market: "STK".into(), trading_date: "2026-09-29".into(), session: "DAY".into(), code: code.into() },
            horizon_minutes: 3,
            direction: Direction::Up,
            features: vec![],
            categories: vec![],
            input_watermark: watermark,
            generation: 1,
            market_cutoff_ns: 0,
            stream_id: "s".into(),
            epoch: 0,
            config_version: 1,
            enqueued_at_ns: 0,
            expires_at_ns: i64::MAX,
        }
    }

    #[test]
    fn coalesces_pending_keeps_position_and_bounds_depth() {
        let q = TaskQueue::new(2);
        assert_eq!(q.push(task("A", 1)), Pushed::Queued);
        assert_eq!(q.push(task("B", 2)), Pushed::Queued);
        assert_eq!(q.push(task("A", 3)), Pushed::Coalesced, "a waiting slot takes the newer snapshot");
        assert_eq!(q.push(task("C", 4)), Pushed::RejectedFull);
        assert_eq!(q.counts().depth, 2);
        let first = q.pop(Duration::from_millis(1)).unwrap();
        assert_eq!((first.key.code.as_str(), first.input_watermark), ("A", 3), "coalescing kept A's queue position");
        assert_eq!(q.pop(Duration::from_millis(1)).unwrap().key.code, "B");
        assert!(q.pop(Duration::from_millis(1)).is_none());
    }

    #[test]
    fn an_older_snapshot_never_replaces_a_newer_pending_one() {
        let q = TaskQueue::new(4);
        q.push(task("A", 5));
        q.push(task("A", 4));
        assert_eq!(q.pop(Duration::from_millis(1)).unwrap().input_watermark, 5);
    }

    #[test]
    fn retain_drops_by_predicate() {
        let q = TaskQueue::new(4);
        q.push(task("A", 1));
        q.push(task("B", 2));
        assert_eq!(q.retain(|t| t.key.code != "A"), 1);
        assert_eq!(q.pop(Duration::from_millis(1)).unwrap().key.code, "B");
    }
}
