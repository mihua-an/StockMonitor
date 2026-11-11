"""No error handler may swallow a failure without a record.

Every handler either records the failure (log / console / remediation / re-raise) or says why it is not an error
(`not an error: <reason>`). scripts/silent_catch_scan.py is the scanner; this keeps the count at zero.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _scanner():
    spec = importlib.util.spec_from_file_location("silent_catch_scan", ROOT / "scripts" / "silent_catch_scan.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_no_silent_error_handlers():
    found = _scanner().scan()
    listing = "\n".join(f"{path}:{line}: {source}" for path, line, source in found[:50])
    assert not found, f"{len(found)} handler(s) swallow a failure without a record or a 'not an error:' reason:\n{listing}"


def test_scanner_finds_a_silent_handler(tmp_path):
    scan = _scanner()
    js = tmp_path / "a.js"
    js.write_text("try { f(); } catch (_error) {}\nvoid p.catch(() => {});\n", encoding="utf-8")
    py = tmp_path / "a.py"
    py.write_text("try:\n    f()\nexcept Exception:\n    pass\n", encoding="utf-8")
    assert len(scan.scan_js(js)) == 2
    assert len(scan.scan_py(py)) == 1
    js.write_text("try { f(); } catch (error) { console.warn('x', error); }\n"
                  "void p.catch(() => { /* not an error: gone */ });\n", encoding="utf-8")
    py.write_text("try:\n    f()\nexcept Exception:  # not an error: optional\n    pass\n", encoding="utf-8")
    assert scan.scan_js(js) == []
    assert scan.scan_py(py) == []
    # Bodies with braces of their own: an object literal returned in place of the failure is still silent ...
    js.write_text("try { f(); } catch (_error) { return { ok: false }; }\nconst a = await p.catch(() => ({}));\n", encoding="utf-8")
    assert len(scan.scan_js(js)) == 2
    # ... while a handler that hands the error on, or records it with an optional call, is not.
    js.write_text("const a = await p.catch((error) => ({ failed: error }));\n"
                  "p.catch((error) => logger.warn?.(`x ${error}`));\n", encoding="utf-8")
    assert scan.scan_js(js) == []


SILENT_JS = {
    # recording on one branch only: the ENOENT path returns without a record
    "one branch records": "function f() { try { g(); } catch (error) { if (error?.code !== 'ENOENT') console.warn('x', error); return {}; } }",
    "ternary records": "function f() { try { g(); } catch (error) { error.code === 'X' ? console.warn('x') : null; return 1; } }",
    "else arm leaves": "function f() { try { g(); } catch (error) { if (a) { console.warn('x'); } else { return 0; } } }",
    # only reading or formatting the error
    "inspected only": "function f() { try { g(); } catch (error) { if (error.code === 'EPERM') return true; return false; } }",
    "formatted, re-wrapped, not recorded": "function f() { try { g(); } catch (error) { return { ok: false, error: String(error?.message || error) }; } }",
    "promise re-wrapped": "const r = await p.catch((error) => ({ ok: false, error: String(error?.message || error) }));",
    "message stored": "function f() { try { g(); } catch (error) { lastError = `x: ${error.message}`; } }",
    "falls off the function end": "function f() { try { g(); } catch (error) { state = error.code; } }",
}

RECORDED_JS = {
    "both arms record": "function f() { try { g(); } catch (error) { if (a) console.warn('a', error); else console.error('b', error); return 1; } }",
    "recorded before the branch": "function f() { try { g(); } catch (error) { console.warn('x', error); if (error.code === 'ENOENT') return {}; return null; } }",
    "error object handed on": "function f() { try { g(); } catch (error) { return { ok: false, error }; } }",
    "rethrown later": "function f() { try { g(); } catch (error) { queueMicrotask(() => { throw error; }); } }",
    "falls through to a record": "function f() { let e; try { g(); } catch (caught) { e = String(caught); }\n  logger.warn(`x ${e}`); return e; }",
    "annotated on its closing line": "function f() { try { g(); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }   // absent is not an error: no folder\n}",
}

SILENT_PY = {
    "one branch records": "def f():\n    try:\n        g()\n    except OSError as exc:\n        if exc.errno != 2:\n            log.warning('x %s', exc)\n        return {}\n",
    "inspected only": "def f():\n    try:\n        g()\n    except OSError as exc:\n        if isinstance(exc, PermissionError):\n            return True\n        return False\n",
    "formatted, re-wrapped, not recorded": "def f():\n    try:\n        g()\n    except Exception as exc:\n        return {'ok': False, 'error': str(exc)}\n",
    "message stored": "def f(self):\n    try:\n        g()\n    except Exception as exc:\n        self.last_error = f'{type(exc).__name__}: {exc}'\n",
    "loop continues": "def f(items):\n    for item in items:\n        try:\n            g(item)\n        except ValueError as exc:\n            errors.append(str(exc))\n            continue\n",
}

RECORDED_PY = {
    "both arms record": "def f():\n    try:\n        g()\n    except OSError as exc:\n        if exc.errno == 2:\n            log.info('absent %s', exc)\n        else:\n            log.warning('x %s', exc)\n        return {}\n",
    "exception handed on": "def f():\n    try:\n        g()\n    except Exception as exc:\n        return {'ok': False, 'error': exc}\n",
    "falls through to a record": "def f():\n    try:\n        g()\n        error = None\n    except Exception as exc:\n        error = str(exc)\n    log.warning('x %s', error)\n",
    "re-raised": "def f():\n    try:\n        g()\n    except KeyError as exc:\n        raise ValueError('bad row') from exc\n",
}


@pytest.mark.parametrize("name", sorted(SILENT_JS))
def test_js_path_without_a_record_is_found(tmp_path, name):
    js = tmp_path / "a.js"
    js.write_text(SILENT_JS[name], encoding="utf-8")
    assert len(_scanner().scan_js(js)) == 1


@pytest.mark.parametrize("name", sorted(RECORDED_JS))
def test_js_handler_recording_on_every_path_passes(tmp_path, name):
    js = tmp_path / "a.js"
    js.write_text(RECORDED_JS[name], encoding="utf-8")
    assert _scanner().scan_js(js) == []


@pytest.mark.parametrize("name", sorted(SILENT_PY))
def test_py_path_without_a_record_is_found(tmp_path, name):
    py = tmp_path / "a.py"
    py.write_text(SILENT_PY[name], encoding="utf-8")
    assert len(_scanner().scan_py(py)) == 1


@pytest.mark.parametrize("name", sorted(RECORDED_PY))
def test_py_handler_recording_on_every_path_passes(tmp_path, name):
    py = tmp_path / "a.py"
    py.write_text(RECORDED_PY[name], encoding="utf-8")
    assert _scanner().scan_py(py) == []


def test_a_handler_doing_more_than_one_thing_still_needs_a_record(tmp_path):
    # A handler that sets a fallback AND counts / assigns must not pass the scanner.
    scan = _scanner()
    py = tmp_path / "b.py"
    py.write_text("try:\n    rows = repo.read()\nexcept Exception:\n    rows = []\n    misses += 1\n", encoding="utf-8")
    assert len(scan.scan_py(py)) == 1
    py.write_text("try:\n    rows = repo.read()\nexcept Exception as exc:\n    record_failure(log, 'reading rows', exc)\n    rows = []\n", encoding="utf-8")
    assert scan.scan_py(py) == []
    py.write_text("try:\n    rows = repo.read()\nexcept KeyError:\n    raise ValueError('bad row')\n", encoding="utf-8")
    assert scan.scan_py(py) == []
    js = tmp_path / "b.js"
    js.write_text("try { reply = JSON.parse(line); } catch (_error) { this.late += 1; return; }\n", encoding="utf-8")
    assert len(scan.scan_js(js)) == 1
    js.write_text("try { reply = JSON.parse(line); } catch (error) { this.late += 1; console.warn('[parse] failed', error); return; }\n", encoding="utf-8")
    assert scan.scan_js(js) == []
