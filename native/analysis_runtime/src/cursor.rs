//! The worker's own durable cursor. The rules are the base protocol's, exactly as
//! the former Python RuntimeAnalysisProjectionWorker (removed)
//! applies them -- this is a second consumer of the same stream, not a second set of rules:
//!
//! * the cursor follows events actually applied, never a batch's `to_sequence`;
//! * Market Runtime declares every range it cannot deliver as a `durable.gap` with its reason (PRUNED or
//!   UNREADABLE) before the records after it. So a sequence above cursor+1 on the live path is a
//!   delivery hole: stop, resubscribe from the cursor (A reads the range from its WAL or declares it), and drop every
//!   batch until that resubscription is acknowledged. A replay batch that jumps without a declaration breaks A's
//!   contract: it is marked as lost input and counted, never guessed to be permanent or not. (The old rule -- "still
//!   missing on the second try is a permanent hole", with a memory of holes for late arrivals -- is gone.)
//! * a different `durable_stream_id`, or a head below the cursor, is a different history:
//!   reset everything and replay from 0.

use std::collections::VecDeque;

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Apply,
    /// Already applied.
    Duplicate,
    /// Stop this batch and resubscribe from `after`.
    Gap { after: u64 },
    /// A replay batch skipped (from..=through) with no `durable.gap` for it: apply the event, the range is lost input.
    Undeclared { from: u64, through: u64 },
}

#[derive(Debug, PartialEq, Eq)]
pub enum GapAction {
    /// Nothing held is affected: the cursor moved past the gap (or it was stale).
    Skip,
    /// Discard the projected state and resubscribe after `after`.
    Rebuild { after: u64 },
    /// The cursor moved past events that are gone for good: mark what the held state may have lost.
    Hole,
}

#[derive(Debug, Default)]
pub struct DurableCursor {
    pub cursor: u64,
    pub stream_id: Option<String>,
    /// Batches are dropped until a `durable.subscribed` acknowledges this `after_sequence`.
    pub awaiting_after: Option<u64>,
    /// The `after_sequence` of every `durable.subscribe` sent on this connection and not answered yet, oldest first.
    /// Market Runtime answers them in order, so each `durable.subscribed` must acknowledge the oldest one.
    pub requested: VecDeque<u64>,
    pub head: u64,
    /// Live delivery holes (each a resubscription).
    pub gaps: u64,
    /// Sequences lost for good: declared UNREADABLE, or skipped by a replay without a declaration.
    pub permanent_holes: u64,
    /// Replay jumps Market Runtime did not declare (a contract violation; zero expected).
    pub undeclared_gaps: u64,
    /// Sequences removed by WAL retention before this worker held anything from them (a fresh start).
    pub pruned_skipped: u64,
    pub duplicates: u64,
    pub resets: u64,
    pub dropped_before_resubscribe: u64,
    pub last_reset_reason: Option<String>,
    /// Where the current catching-up span started (None while caught up): the lowest cursor of the span, so a reset
    /// back to 0 during it starts the span over. What the screens' 分析資料重建中 progress is measured from.
    pub catch_up_from: Option<u64>,
}

/// Why a subscription found a different history than the one the cursor is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamReset {
    /// Market Runtime serves another durable stream.
    StreamChanged(String),
    /// The same stream id, but its head is below what B already applied.
    HeadBelowCursor(String),
}

impl StreamReset {
    pub fn reason(&self) -> &str {
        match self {
            Self::StreamChanged(r) | Self::HeadBelowCursor(r) => r,
        }
    }
}

impl DurableCursor {
    /// A fresh subscription is being opened from our own cursor.
    pub fn opening(&mut self) -> u64 {
        self.awaiting_after = None;
        self.requested.clear();
        self.cursor
    }

    /// A `durable.subscribe` from `after` went out.
    pub fn subscribe_sent(&mut self, after: u64) {
        self.requested.push_back(after);
    }

    /// Judge a `durable.subscribed`. Err when it does not acknowledge the oldest unanswered `durable.subscribe`: the
    /// batches after it would start somewhere B did not ask for. Ok(Some) says why the history changed, when it did.
    pub fn on_subscribed(&mut self, after: u64, head: u64, stream_id: &str) -> Result<Option<StreamReset>, String> {
        match self.requested.pop_front() {
            Some(asked) if asked == after => {}
            Some(asked) => return Err(format!("durable.subscribed acknowledges after_sequence {after}, B asked for {asked}")),
            None => return Err(format!("durable.subscribed (after_sequence {after}) answers no durable.subscribe")),
        }
        if self.awaiting_after == Some(after) {
            self.awaiting_after = None;
        }
        let mut reason = None;
        if let Some(old) = self.stream_id.as_deref() {
            if stream_id != old {
                reason = Some(StreamReset::StreamChanged(format!("durable stream changed {old} -> {stream_id}")));
            }
        }
        if reason.is_none() && self.cursor > head {
            reason = Some(StreamReset::HeadBelowCursor(format!("durable head {head} below cursor {}", self.cursor)));
        }
        self.stream_id = Some(stream_id.to_string());
        // After a reset, the head of the NEW history, not the max with the old one.
        self.head = if reason.is_some() { head } else { self.head.max(head) };
        Ok(reason)
    }

    /// Judge a `durable.gap`: Market Runtime has no events in (cursor, through]. `pruned` means retention removed
    /// them; otherwise they are unreadable (a corrupt WAL span). `holding_state` is whether anything was projected
    /// from events before the gap: the cursor must never jump while the state carries on as if complete.
    pub fn on_gap(&mut self, through: u64, pruned: bool, holding_state: bool) -> GapAction {
        if self.awaiting_after.is_some() || through <= self.cursor {
            // Sent before our resubscription was acknowledged, or already behind us.
            return GapAction::Skip;
        }
        if pruned {
            if holding_state {
                // The held sessions lost their tail for good, and retention only removes days the newest state
                // no longer needs: discard and rebuild from what the WAL still has.
                return GapAction::Rebuild { after: through };
            }
            self.pruned_skipped += through - self.cursor;
            self.applied(through);
            return GapAction::Skip;
        }
        self.permanent_holes += through - self.cursor;
        self.applied(through);
        GapAction::Hole
    }

    /// Everything goes: cursor, holes, gap state. The caller drops its feature state with it and
    /// resubscribes from 0.
    pub fn reset(&mut self, reason: String) {
        self.cursor = 0;
        self.awaiting_after = Some(0);
        self.resets += 1;
        self.last_reset_reason = Some(reason);
    }

    pub fn accepting_batches(&mut self) -> bool {
        if self.awaiting_after.is_some() {
            self.dropped_before_resubscribe += 1;
            return false;
        }
        true
    }

    /// `replay`: the batch is Market Runtime's read of its WAL (it declares what it cannot deliver), not live delivery.
    pub fn classify(&mut self, sequence: Option<u64>, replay: bool) -> Decision {
        let expected = self.cursor + 1;
        let Some(sequence) = sequence.filter(|s| *s > 0) else {
            // Cannot be placed in the sequence, so cannot be applied exactly once.
            return self.gap();
        };
        if sequence < expected {
            self.duplicates += 1;
            return Decision::Duplicate;
        }
        if sequence > expected {
            if replay {
                self.undeclared_gaps += 1;
                self.permanent_holes += sequence - expected;
                return Decision::Undeclared { from: expected, through: sequence - 1 };
            }
            return self.gap();
        }
        Decision::Apply
    }

    fn gap(&mut self) -> Decision {
        self.gaps += 1;
        self.awaiting_after = Some(self.cursor);
        Decision::Gap { after: self.cursor }
    }

    pub fn applied(&mut self, sequence: u64) {
        self.cursor = self.cursor.max(sequence);
        self.head = self.head.max(sequence);
    }

    pub fn saw_head(&mut self, to_sequence: Option<u64>) {
        if let Some(to) = to_sequence {
            self.head = self.head.max(to);
        }
    }

    /// Follow the catching-up span at each status report: it opens at the cursor when B falls behind and closes when
    /// B is caught up.
    pub fn track_catch_up(&mut self, caught_up: bool) {
        self.catch_up_from = if caught_up { None } else { Some(self.catch_up_from.map_or(self.cursor, |from| from.min(self.cursor))) };
    }

    pub fn lag(&self) -> u64 {
        self.head.saturating_sub(self.cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_durable_gap_is_never_a_silent_jump() {
        // The cursor jumped to `committed` and the held state carried on as complete.
        let held = |cursor: u64| DurableCursor { cursor, ..Default::default() };

        let mut c = held(10);
        assert_eq!(c.on_gap(100, true, true), GapAction::Rebuild { after: 100 }, "pruned past held state: rebuild");
        assert_eq!(c.cursor, 10, "the rebuild moves the cursor, not the gap");

        let mut c = held(0);
        assert_eq!(c.on_gap(100, true, false), GapAction::Skip, "fresh start: nothing held, retention is expected");
        assert_eq!((c.cursor, c.pruned_skipped, c.permanent_holes), (100, 100, 0));

        let mut c = held(10);
        assert_eq!(c.on_gap(40, false, true), GapAction::Hole, "unreadable span: mark what was held");
        assert_eq!((c.cursor, c.permanent_holes), (40, 30));

        let mut c = held(50);
        assert_eq!(c.on_gap(40, true, true), GapAction::Skip, "already behind the cursor");
        let mut c = DurableCursor { cursor: 10, awaiting_after: Some(10), ..Default::default() };
        assert_eq!(c.on_gap(100, true, true), GapAction::Skip, "sent before our resubscription was acknowledged");
        assert_eq!(c.cursor, 10);
    }

    #[test]
    fn contiguous_then_duplicate() {
        let mut c = DurableCursor::default();
        for s in 1..=3 {
            assert_eq!(c.classify(Some(s), false), Decision::Apply);
            c.applied(s);
        }
        assert_eq!(c.classify(Some(2), false), Decision::Duplicate);
        assert_eq!(c.cursor, 3);
    }

    #[test]
    fn a_live_hole_resubscribes_and_only_a_declaration_makes_it_lost() {
        let mut c = DurableCursor::default();
        c.classify(Some(1), false);
        c.applied(1);
        assert_eq!(c.classify(Some(4), false), Decision::Gap { after: 1 });
        assert!(!c.accepting_batches(), "batches of the superseded subscription are dropped");
        c.subscribe_sent(1);
        assert_eq!(c.on_subscribed(1, 4, "s"), Ok(None));
        assert!(c.accepting_batches());
        // Market Runtime declares (1, 3] unreadable before it sends 4: the hole is its statement, not a guess.
        assert_eq!(c.on_gap(3, false, true), GapAction::Hole);
        assert_eq!(c.permanent_holes, 2);
        assert_eq!(c.classify(Some(4), true), Decision::Apply);
        c.applied(4);
        assert_eq!(c.classify(Some(3), true), Decision::Duplicate, "nothing behind the cursor is applied again");
        assert_eq!(c.undeclared_gaps, 0);
    }

    #[test]
    fn a_replay_jump_without_a_declaration_is_lost_input_and_counted() {
        let mut c = DurableCursor { cursor: 5, ..Default::default() };
        assert_eq!(c.classify(Some(9), true), Decision::Undeclared { from: 6, through: 8 });
        assert_eq!((c.undeclared_gaps, c.permanent_holes), (1, 3));
        c.applied(9);
        assert_eq!(c.cursor, 9);
    }

    #[test]
    fn stream_change_or_head_below_cursor_resets() {
        let mut c = DurableCursor::default();
        c.subscribe_sent(0);
        assert_eq!(c.on_subscribed(0, 10, "a"), Ok(None));
        for s in 1..=10 {
            c.classify(Some(s), false);
            c.applied(s);
        }
        c.subscribe_sent(10);
        c.subscribe_sent(10);
        assert_eq!(c.on_subscribed(10, 10, "a"), Ok(None), "same history resumes");
        assert!(c.on_subscribed(10, 12, "b").unwrap().is_some(), "a new id is a new history even with a higher head");
        assert_eq!(c.head, 12, "the new history's head");
        let mut d = DurableCursor::default();
        d.classify(Some(1), false);
        d.applied(1);
        d.classify(Some(2), false);
        d.applied(2);
        d.subscribe_sent(2);
        assert!(d.on_subscribed(2, 1, "a").unwrap().is_some());
        d.reset("x".into());
        assert_eq!(d.cursor, 0);
        assert_eq!(d.awaiting_after, Some(0));
    }

    #[test]
    fn a_subscribed_must_acknowledge_the_oldest_request() {
        let mut c = DurableCursor { cursor: 7, awaiting_after: Some(7), ..Default::default() };
        assert!(c.on_subscribed(7, 9, "a").is_err(), "nothing was asked on this connection");
        c.subscribe_sent(7);
        c.subscribe_sent(0);
        assert!(c.on_subscribed(0, 9, "a").is_err(), "answers out of order: B would read from the wrong place");
        let mut c = DurableCursor { cursor: 7, awaiting_after: Some(7), ..Default::default() };
        c.subscribe_sent(7);
        c.subscribe_sent(0);
        assert_eq!(c.on_subscribed(7, 9, "a"), Ok(None));
        assert_eq!(c.awaiting_after, None);
        assert_eq!(c.requested, VecDeque::from([0]));
        assert_eq!(c.opening(), 7);
        assert!(c.requested.is_empty(), "a new connection's answers are about its own requests");
    }

    #[test]
    fn missing_sequence_is_a_gap_not_an_apply() {
        let mut c = DurableCursor::default();
        assert_eq!(c.classify(None, false), Decision::Gap { after: 0 });
    }

    #[test]
    fn catch_up_span_opens_behind_restarts_on_reset_and_closes_when_caught_up() {
        let mut c = DurableCursor { cursor: 500, ..Default::default() };
        c.track_catch_up(true);
        assert_eq!(c.catch_up_from, None);
        c.track_catch_up(false);
        assert_eq!(c.catch_up_from, Some(500), "the span starts where B fell behind");
        c.applied(800);
        c.track_catch_up(false);
        assert_eq!(c.catch_up_from, Some(500), "progress through the span keeps its start");
        c.reset("stream changed".into());
        c.track_catch_up(false);
        assert_eq!(c.catch_up_from, Some(0), "a reset during the span rebuilds from the start");
        c.applied(900);
        c.track_catch_up(true);
        assert_eq!(c.catch_up_from, None);
    }
}
