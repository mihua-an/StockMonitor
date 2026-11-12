//! What the process holds on its heap, counted by its allocator (`Counting`, installed by the daemon binary): the
//! bytes live now and the most ever live at once. A process's private working set also holds memory it freed and
//! the system heap kept, so the two together say whether a high figure is data held or a past peak (metrics `heap`).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// Whether `Counting` is the process's allocator (a test binary uses the system one: nothing is counted).
static INSTALLED: AtomicUsize = AtomicUsize::new(0);

/// The system allocator, counting what is live.
pub struct Counting;

fn grew(by: usize) {
    let now = LIVE.fetch_add(by, Ordering::Relaxed) + by;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

// SAFETY: every call forwards to `System` with the same arguments; the counters do not touch the memory.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        INSTALLED.store(1, Ordering::Relaxed);
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        INSTALLED.store(1, Ordering::Relaxed);
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            grew(new_size);
        }
        p
    }
}

/// `{"live_bytes", "peak_bytes"}`, or null when the process does not count (`Counting` is not its allocator).
pub fn wire() -> serde_json::Value {
    if INSTALLED.load(Ordering::Relaxed) == 0 {
        return serde_json::Value::Null;
    }
    serde_json::json!({"live_bytes": LIVE.load(Ordering::Relaxed), "peak_bytes": PEAK.load(Ordering::Relaxed)})
}
