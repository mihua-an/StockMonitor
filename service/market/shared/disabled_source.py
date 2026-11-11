"""Passive bridge compatibility object: never imports or constructs a client."""
from service.market.shared.source_runtime import disabled_source


class DisabledSourceClient:
    app = None
    thread = None
    running = False
    started_at = None
    last_error = None
    last_result = None

    def __init__(self, source):
        self.source = source

    def status(self):
        return {**disabled_source(self.source), "attached": False, "thread_alive": False,
                "monitor_state": "disabled", "monitor_state_text": "未啟用"}

    def start(self, *args, **kwargs):
        return self.status()

    def stop(self, *args, **kwargs):
        return {**self.status(), "ok": True}

    def start_in_background(self, *args, **kwargs):
        return None

    attach_in_background = start_in_background

    def cached_health(self, *args, **kwargs):
        return self.status()

    health = cached_health
    refresh_health = cached_health
    stats = cached_health
    stream_stats = cached_health
    get_json = start
    post_json = start
    call = start
