"""Architectural invariants for the Electron renderer's display authority.

These tests protect *behavior* (which module owns which DOM writes, which
staleness guards actually reject stale data, which functions must/must not
exist) rather than exact JS source text. The real modules are imported and
run by small Node contract scripts (tests/display_authority_*_contract.mjs)
-- see each script's header comment for the specific invariant it drives at
runtime. Where genuine behavioral testing
isn't practical (e.g. an import graph too deep/DOM-coupled to run in plain
Node, or an architectural absence that only means "this name must not
reappear"), a source-text check remains, but anchored with a regex and
`pytest.fail`-ed clearly rather than sliced with `str.index()` between two
arbitrarily-chosen function names (which raises a raw ValueError -- and
silently mis-scopes the slice -- the moment a sibling function is renamed,
reordered, or inserted).
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
REALTIME = ROOT / "ui" / "renderer" / "js" / "pages" / "realtime.js"
# The controllers split out of pages/realtime.js (tests/lib/realtime_sources.mjs lists the same modules).
REALTIME_CONTROLLERS = tuple(
    ROOT / "ui" / "renderer" / "js" / "features" / "realtime" / f"{name}.js"
    for name in (
        "live_page_state", "session_state", "product_pages", "live_redraw", "canonical_view_owner",
        "live_view_models", "selection_controller", "session_controller", "startup_diagnostics",
    )
)
MONITOR = ROOT / "ui" / "renderer" / "js" / "features" / "realtime" / "realtime_presentation.js"
REALTIME_HTML = ROOT / "ui" / "renderer" / "pages" / "realtime.html"
GATE = ROOT / "ui" / "renderer" / "js" / "core" / "display_frame_gate.js"
MOOMOO_COMPONENTS = ROOT / "ui" / "renderer" / "js" / "features" / "realtime" / "components" / "moomoo_components.js"
TREND_COMPONENT = ROOT / "ui" / "renderer" / "js" / "core" / "components" / "trend_chart_component.js"
HISTORY = ROOT / "ui" / "renderer" / "js" / "pages" / "history.js"
HISTORY_HTML = ROOT / "ui" / "renderer" / "pages" / "history.html"


def _realtime_page_source() -> str:
    """The 即時報價 page as one text: pages/realtime.js and its controllers, so a check holds wherever a function lives."""
    return "\n".join(path.read_text(encoding="utf-8") for path in (REALTIME, *REALTIME_CONTROLLERS))


def _run_node_contract(filename: str) -> None:
    """Run a tests/display_authority_*_contract.mjs script and surface its
    full output on failure. `node` is a hard dependency of this suite (like
    the existing tests/source_enablement_contract.cjs invocation in
    test_source_enablement.py); if it is missing, subprocess.run raises a
    clear FileNotFoundError naming "node" rather than failing silently.
    """
    script = ROOT / "tests" / filename
    result = subprocess.run(
        ["node", str(script)], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def _find_matching_brace(source: str, open_index: int) -> int:
    """Scan forward from an opening `{` to its own matching `}`, skipping
    over string/template literals and comments so braces inside them don't
    confuse the depth count."""
    depth = 0
    i = open_index
    n = len(source)
    template_stack: list[int] = []
    in_template = False
    while i < n:
        ch = source[i]
        if in_template:
            if ch == "\\":
                i += 2
                continue
            if ch == "`":
                in_template = False
                i += 1
                continue
            if ch == "$" and i + 1 < n and source[i + 1] == "{":
                template_stack.append(depth)
                depth += 1
                in_template = False
                i += 2
                continue
            i += 1
            continue
        if ch == "`":
            in_template = True
            i += 1
            continue
        if ch in ("\"", "'"):
            quote = ch
            i += 1
            while i < n and source[i] != quote:
                i += 2 if source[i] == "\\" else 1
            i += 1
            continue
        if ch == "/" and i + 1 < n and source[i + 1] == "/":
            while i < n and source[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and source[i + 1] == "*":
            i += 2
            while i < n and not (source[i] == "*" and i + 1 < n and source[i + 1] == "/"):
                i += 1
            i += 2
            continue
        if ch == "{":
            depth += 1
            i += 1
            continue
        if ch == "}":
            depth -= 1
            if template_stack and depth == template_stack[-1]:
                template_stack.pop()
                in_template = True
                i += 1
                continue
            if depth == 0:
                return i
            i += 1
            continue
        i += 1
    raise AssertionError("unbalanced braces while scanning for block end")


def _extract_block(source: str, header_pattern: str, *, label: str, path: Path) -> str:
    """Return a function/method's own source, from its header through its
    OWN matching closing brace -- never to the start of some other, later
    function. Unlike `source[source.index(A):source.index(B)]`, this is
    immune to reordering or insertion of sibling functions between A and B,
    and fails with a clear pytest message (rather than a raw ValueError) if
    the function has been renamed, moved, or removed.
    """
    match = re.search(header_pattern, source)
    if not match:
        pytest.fail(f"could not find {label} in {path} (pattern: {header_pattern!r}); has it been renamed, moved, or removed?")
    open_brace = source.index("{", match.end() - 1)
    end = _find_matching_brace(source, open_brace)
    return source[match.start():end + 1]


def test_frontend_never_reads_the_wall_clock_for_a_trading_date():
    # The page's stockCanonicalViewSpec / taiexCanonicalViewSpec
    # (features/realtime/session_state.js) run against a spied Date
    # constructor: the wall clock is never read, and an unknown session
    # authority yields an empty trading date (never a guess).
    _run_node_contract("display_authority_no_wall_clock_contract.mjs")


def test_status_commits_display_context_before_reconnect_subscription():
    source = _realtime_page_source()
    # Actual ordering and late-result rejection are executed by
    # renderer_page_lifecycle_contract.mjs; keep this assembly-wiring check
    # (regex-anchored so formatting/whitespace changes don't break it).
    assert re.search(r"applyStatus\s*:\s*applyRealtimeStatus\b", source), (
        "realtimeSessionLifecycle must be wired with the real applyRealtimeStatus as its applyStatus hook"
    )
    # The session itself is Market Runtime's push (session.current / session.rollover), never read from /api/status.
    assert re.search(r"subscribeSession\s*:\s*subscribeRealtimeSession\s*,\s*applySession\s*:\s*applyRealtimeSession\b", source)
    assert "display_context" not in source
    lifecycle = (ROOT / "ui/renderer/js/features/realtime/session_lifecycle.js").read_text(encoding="utf-8")
    assert not re.search(r"""from\s+["'][^"']*\bpages/""", lifecycle), (
        "session_lifecycle.js is a reusable feature module and must not import from pages/"
    )


def test_visible_components_use_the_presentation_revision_gate():
    # The data source stamps each delivery with a presentation revision and every visible panel
    # paints only in that order (driven for real by the node contract); no panel re-derives the transport's order.
    _run_node_contract("display_authority_gate_contract.mjs")
    for relative in (
        "ui/renderer/js/core/components/tick_details_component.js",
        "ui/renderer/js/core/components/orderbook_component.js",
        "ui/renderer/js/core/components/trend_chart_component.js",
    ):
        source = (ROOT / relative).read_text(encoding="utf-8")
        assert re.search(r"""import\s*\{[^}]*\bPresentationRevisionGate\b[^}]*\}\s*from\s*["'][^"']*display_frame_gate\.js["']""", source), (
            f"{relative} must import the shared PresentationRevisionGate"
        )
        assert re.search(r"!\s*this\.displayFrameGate\.accept\(", source), (
            f"{relative} must gate its render path behind `!this.displayFrameGate.accept(...)`"
        )


def test_futures_header_has_one_dom_writer_and_one_change_format():
    # The change-format itself (a visually distinct slash-separated form for
    # futures) is exercised behaviorally, with real numbers through the real
    # extracted _syncLocalHeader method, by
    # display_authority_futures_format_contract.mjs.
    _run_node_contract("display_authority_futures_format_contract.mjs")
    realtime = _realtime_page_source()
    # File-wide (not sliced to one function): TrendChartComponent must be the
    # ONLY writer of these header nodes anywhere in realtime.js.
    assert '$("selectedQuotePrice")' not in realtime, (
        "realtime.js must not imperatively write the price header; TrendChartComponent owns it"
    )
    assert '$("selectedQuoteChange")' not in realtime, (
        "realtime.js must not imperatively write the change header; TrendChartComponent owns it"
    )


def test_realtime_page_has_no_legacy_orderbook_dom_renderer():
    source = MONITOR.read_text(encoding="utf-8")
    for legacy_name in (
        "renderOrderbookSummary",
        "renderOrderbookExtremeMarker",
        "renderOrderbookQtyCell",
        "renderOrderbookPriceCell",
        "getOrderbookPriceClass",
        "isValidPrice",
    ):
        # A plain absence check is not fragile to reformatting -- only to
        # intentionally reintroducing the legacy renderer, which is exactly
        # what this guards against.
        assert legacy_name not in source, f"legacy orderbook renderer {legacy_name} must not be reintroduced into realtime_presentation.js"
    assert re.search(r"export\s+function\s+renderRealtimeOrderbook\s*\(", source), (
        "realtime_presentation.js must still export renderRealtimeOrderbook as the shared orderbook entry point"
    )


def test_trend_component_is_the_only_live_and_replay_header_writer():
    realtime = _realtime_page_source()
    monitor = MONITOR.read_text(encoding="utf-8")
    history = HISTORY.read_text(encoding="utf-8")
    markup = REALTIME_HTML.read_text(encoding="utf-8")
    # File-wide, not sliced to one function: strictly stronger than "absent
    # from renderTaiexAsPrimaryNow only".
    assert '$("selectedQuotePrice")' not in realtime, (
        "realtime.js must not imperatively write the TAIEX price header; TrendChartComponent owns it"
    )
    assert "renderSelectedRealtimeDetail" not in monitor
    assert "renderSelectedRealtimeDetail" not in realtime
    assert "renderHistoryHeader" not in history
    assert "renderHistoryMetrics" not in history
    assert 'id="trendTabs"' not in markup
    assert 'id="orderbookTabs"' not in markup


def test_futures_session_control_has_one_dom_owner():
    realtime = _realtime_page_source()
    component = TREND_COMPONENT.read_text(encoding="utf-8")
    assert not re.search(r"function\s+syncTxfSessionControl\s*\(", realtime), (
        "futures session control must not have its own DOM-owning function reintroduced into realtime.js"
    )
    assert "renderTrendSessionControl" not in realtime, (
        "realtime.js must not call the session-control renderer directly; TrendChartComponent owns that wiring"
    )
    assert re.search(r"_syncFuturesSessionControl\s*\(", component), (
        "trend_chart_component.js must own futures session control via _syncFuturesSessionControl"
    )


def test_moomoo_components_cancel_scheduler_and_unsubscribe_on_destroy():
    # The real Futu component classes' destroy() (base class + each
    # shared-component subclass) run on instances of the imported classes:
    # verifies the scheduler is cancelled, queued cleanup
    # callbacks are drained and run, and the shared sub-component is
    # destroyed and released.
    _run_node_contract("display_authority_destroy_contract.mjs")


def test_async_bootstrap_paths_reject_stale_symbol_or_generation_results():
    # live_trade_pager.js's generation/intent guard is imported and driven
    # for real, and asserts only on the OBSERVABLE outcome (a late stale
    # response never overwrites an already-applied fresher one) rather than
    # on the literal `requestGeneration` field name -- a planned follow-up
    # migrates this to the shared LatestIntentGate primitive, and this
    # contract is written to survive that regardless of which mechanism
    # backs it.
    _run_node_contract("display_authority_stale_trade_page_contract.mjs")

    source = _realtime_page_source()
    # The realtime-context REST fill (and the stale-response guard it needed) is gone: 大單流向 comes only from the
    # canonical view. It must not come back.
    assert "/api/monitor/context" not in source
    assert "refreshRealtimeContext" not in source
    # The closed-session panel prewarm (`preloadClosedSessionPanels`, guarded by
    # `closedPanelPrewarmGeneration`) no longer exists in the renderer at all -- so the
    # superseded-generation hazard it guarded against cannot occur. Assert its absence rather
    # than its guard, and keep the ban on the panel bootstrap/repair endpoints in the renderer:
    # reintroducing a prewarm caller without a generation guard is the regression to catch.
    for banned in ("preloadClosedSessionPanels", "closedPanelPrewarmGeneration",
                   "/api/market/panel-bootstrap", "/api/market/panel-repair"):
        assert banned not in source, f"{banned} reappeared on the 即時報價 page; re-add a generation guard with it"


def test_history_replay_keeps_intraday_trend_instead_of_kline_override():
    source = HISTORY.read_text(encoding="utf-8")
    markup = HISTORY_HTML.read_text(encoding="utf-8")
    render_section = _extract_block(
        source, r"function\s+rerenderHistoryCurrentChart\s*\([^)]*\)\s*\{",
        label="rerenderHistoryCurrentChart", path=HISTORY,
    )
    assert 'invalidateReplayComponents("trendChart")' in render_section, (
        "the replay chart must redraw through the shared trend component instead of drawing its own kline"
    )
    assert "drawHistoryKline" not in source, "the legacy kline drawer must not be reintroduced into history.js"
    assert "getKlineCached" not in source, "the legacy kline cache reader must not be reintroduced into history.js"
    assert "data-history-kline-period" not in markup, "the legacy kline period control must not be reintroduced into history.html"
