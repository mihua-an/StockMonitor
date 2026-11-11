//! A position pushed to a peer on its own connection, so the peer can release what it holds through it: the WAL's
//! committed watermark to a provider holding the events A accepted but has not synced yet (docs/system-architecture/03
//! section 3). The holder needs no limit of its own: it holds only what the reporter took into its bounded queue (A's
//! WAL queue), so the reporter's queue is the one bound, and a full one refuses new work there.
//!
//! The same shape serves any "acknowledged up to here" stream between two processes (a consumer reporting how far it
//! processed to a producer that must not run ahead of it).

/// What was last pushed: the position and whether the source had failed.
#[derive(Default)]
pub(crate) struct PositionPush {
    last: Option<(u64, bool)>,
}

impl PositionPush {
    /// The position to push now: always the first time (the peer learns where it stands, after a reconnect too),
    /// then whenever the position moved or the source's failure state changed. None: nothing new to tell.
    pub(crate) fn due(&mut self, position: u64, failed: bool) -> Option<u64> {
        if self.last == Some((position, failed)) {
            return None;
        }
        self.last = Some((position, failed));
        Some(position)
    }
}

#[cfg(test)]
mod tests {
    use super::PositionPush;

    #[test]
    fn the_first_position_is_always_told_then_only_a_move_or_a_failure() {
        let mut push = PositionPush::default();
        assert_eq!(push.due(0, false), Some(0), "a peer that just subscribed learns where it stands");
        assert_eq!(push.due(0, false), None);
        assert_eq!(push.due(7, false), Some(7));
        assert_eq!(push.due(7, false), None);
        assert_eq!(push.due(7, true), Some(7), "a failure is told although the position did not move");
        assert_eq!(push.due(7, true), None);
    }
}
