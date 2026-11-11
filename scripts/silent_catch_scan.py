"""Find error handlers that leave no record.

A handler passes only when it does one of these ("anything more than one trivial statement" is not enough:
a handler that swallows the error and sets a fallback value must be found):
  - records the failure: a call to a logger / console / recorder / reporter / remediation emitter;
  - re-raises / re-throws, or hands the error on (uses the caught exception: returns it, stores it, rejects with it);
  - says in a comment why the failure is not an error: `not an error: <reason>` (Python `# not an error: ...`,
    JavaScript `/* not an error: ... */` or `// not an error: ...`).
Every path out of the handler must do one of these: recording only under a condition, or only reading or formatting
the error, leaves the other paths silent. Python handlers are read from the AST; JavaScript handlers from the source
text, split into statements and if / else / try arms.

    python scripts/silent_catch_scan.py            # list every silent handler
    python scripts/silent_catch_scan.py --count    # just the number
"""
from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS_DIRS = ["ui", "service", "health", "config", "scripts", "api", "backend", "integrations"]
PY_DIRS = ["service", "api", "backend", "config", "scripts", "health", "integrations", "ui"]
SKIP_PARTS = {"node_modules", "vendor", "dist", "target", "__pycache__", ".git", "var"}
ANNOTATION = re.compile(r"not an error:", re.I)
# How the paths through a block end: all record, some leave without a record, or some reach its end without one.
RECORDED, SILENT, OPEN = "recorded", "silent", "open"


def _files(dirs: list[str], suffixes: tuple[str, ...]):
    for top in dirs:
        base = ROOT / top
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.suffix in suffixes and not (SKIP_PARTS & set(path.parts)) and path.is_file():
                yield path
    if ".py" in suffixes and (ROOT / "main.py").exists():
        yield ROOT / "main.py"


CATCH_HEAD = re.compile(r"\bcatch\s*(\(\s*(?P<binding>[\w$]*)\s*\))?\s*\{")
PROMISE_HEAD = re.compile(r"\.catch\(\s*(async\s*)?\(\s*(?P<binding>[\w$]*)\s*\)\s*=>\s*")
_CALL = re.compile(r"([\w$\]\)]|\?\.)\s*\(")
# A call that records: console / a logger / anything named record, report, emit, warn, fail(ed), error, log, reject.
RECORDING = re.compile(r"(?i)(console\s*\.\s*(warn|error|log|info|debug)|\b(logger|log|this\.logger|logging)\s*\??\.\s*\w+"
                       r"|[\w$]*(record|report|emit|warn|fail|error|reject|recordFailure|remediat)[\w$]*)\s*\??\.?\s*\(")
_COMMENTS = re.compile(r"/\*.*?\*/|//[^\n]*", re.S)


def _close(text: str, start: int, opening: str, closing: str) -> int:
    """Index just past the bracket that closes the one at `start`, skipping strings, templates and comments."""
    depth, i, n = 0, start, len(text)
    while i < n:
        ch = text[i]
        if ch in "\"'`":
            quote, i = ch, i + 1
            while i < n and text[i] != quote:
                i += 2 if text[i] == "\\" else 1
        elif text.startswith("//", i):
            i = text.find("\n", i)
            i = n if i < 0 else i
            continue
        elif text.startswith("/*", i):
            i = text.find("*/", i)
            i = n if i < 0 else i + 1
        elif ch == opening:
            depth += 1
        elif ch == closing:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def js_handlers(text: str):
    """Every `catch {...}` block and `.catch(() => ...)` handler: (start, end, kind, binding, body).

    kind "block": body is the block's inside. kind "arrow-block": the arrow's `{...}` inside. kind "arrow-expr": the
    arrow's expression (the handler's whole argument up to its closing parenthesis)."""
    for m in CATCH_HEAD.finditer(text):
        end = _close(text, m.end() - 1, "{", "}")
        if end > 0:
            yield m.start(), end, "block", m.group("binding") or "", text[m.end():end - 1]
    for m in PROMISE_HEAD.finditer(text):
        call_end = _close(text, m.start() + len(".catch"), "(", ")")
        if call_end < 0:
            continue
        rest = text[m.end():call_end - 1]
        stripped = _COMMENTS.sub("", rest).strip()
        if stripped.startswith("{") and _close(rest, rest.index("{"), "{", "}") == len(rest.rstrip()):
            inner = rest[rest.index("{") + 1:len(rest.rstrip()) - 1]
            yield m.start(), call_end, "arrow-block", m.group("binding") or "", inner
        else:
            yield m.start(), call_end, "arrow-expr", m.group("binding") or "", rest


_JS_CONTROL = {"if", "else", "for", "while", "do", "switch", "try", "function", "async", "class"}
_JS_EXITS = re.compile(r"(?<![\w$.])(return|break|continue)(?![\w$])")
_JS_CONDITIONAL = re.compile(r"\?(?!\.)|&&|\|\|")
# Builtins that only inspect or format the error: passing it to them does not hand the failure on.
_JS_INSPECTING = re.compile(r"(?<![\w$.])(String|Number|Boolean|JSON\.stringify|Object\.keys)\s*\(\s*$|\btypeof\s*$")


def _skip_string(text: str, i: int) -> int:
    quote, i, n = text[i], i + 1, len(text)
    while i < n and text[i] != quote:
        i += 2 if text[i] == "\\" else 1
    return i + 1


def _head(stmt: str) -> str:
    m = re.match(r"[A-Za-z_$][\w$]*", stmt)
    return m.group(0) if m else ""


def _js_statements(code: str) -> list[str]:
    """Split a block's inside into its top-level statements: at `;`, at the closing brace of a control statement's
    last block, or at a line break that cannot continue the expression."""
    out, depth, i, n, begin = [], 0, 0, len(code), 0

    def cut(at: int) -> None:
        nonlocal begin
        piece = code[begin:at].strip()
        if piece and piece != ";":
            out.append(piece)
        begin = at

    while i < n:
        ch = code[i]
        if ch in "\"'`":
            i = _skip_string(code, i)
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if ch == "}" and depth == 0 and _head(code[begin:].strip()) in _JS_CONTROL:
                if not re.match(r"(else|catch|finally|while)(?![\w$])", code[i + 1:].lstrip()):
                    cut(i + 1)
        elif ch == ";" and depth == 0 and not re.match(r"else(?![\w$])", code[i + 1:].lstrip()):
            cut(i + 1)
        elif ch == "\n" and depth == 0:
            before, after = code[begin:i].strip(), code[i + 1:].lstrip()
            if (before and _head(before) not in _JS_CONTROL and before[-1] not in ",([{+-*/%=&|?:<>!."
                    and not re.match(r"[.?:)\]},+\-*/%=&|]", after)):
                cut(i)
        i += 1
    cut(n)
    return out


def _js_arm(text: str) -> tuple[str, str]:
    """The arm at the start of `text` (a `{...}` block's inside, or one statement) and the text after it."""
    text = text.lstrip()
    if text.startswith("{"):
        end = _close(text, 0, "{", "}")
        return text[1:end - 1], text[end:]
    depth, i, n = 0, 0, len(text)
    while i < n:
        ch = text[i]
        if ch in "\"'`":
            i = _skip_string(text, i)
            continue
        depth += 1 if ch in "([{" else -1 if ch in ")]}" else 0
        if depth == 0 and ch in ";\n":
            break
        i += 1
    return text[:i].strip(), text[i + 1:]


def _js_if_arms(stmt: str) -> list[str]:
    cond_end = _close(stmt, stmt.index("("), "(", ")")
    then, rest = _js_arm(stmt[cond_end:])
    rest = rest.lstrip().lstrip(";").lstrip()
    if re.match(r"else(?![\w$])", rest):
        rest = rest[4:].lstrip()
        return [then, rest if re.match(r"if(?![\w$])", rest) else _js_arm(rest)[0]]
    return [then, ""]


def _js_unconditional(stmt: str, at: int) -> bool:
    """Nothing before position `at` in the statement makes the rest conditional (`?:`, `&&`, `||`, `??`)."""
    return not _JS_CONDITIONAL.search(re.sub(r"(['\"`]).*?\1", "''", stmt[:at]))


def _js_hands_on(stmt: str, binding: str) -> bool:
    """The error object itself leaves the handler: returned, assigned, put in an object / array or passed to a call.
    Reading a property, comparing, formatting or passing it to an inspecting builtin does not."""
    if not binding or binding.startswith("_"):
        return False
    for m in re.finditer(rf"(?<![\w$.]){re.escape(binding)}(?![\w$])", stmt):
        before, after = stmt[:m.start()].rstrip(), stmt[m.end():].lstrip()
        if not re.match(r"($|[),;}\]])", after):
            continue
        if _JS_INSPECTING.search(before) or before.endswith("${"):
            continue
        if re.search(r"(\breturn|\bthrow|[^=!<>]=|[:(,\[]|\.\.\.)$", before) and _js_unconditional(stmt, m.start()):
            return True
    return False


def _js_statement_records(stmt: str, binding: str) -> bool:
    head = _head(stmt)
    if head in _JS_CONTROL:
        return False   # judged by its arms
    if head == "throw":
        return True
    return any(_js_unconditional(stmt, m.start()) for m in RECORDING.finditer(stmt)) or _js_hands_on(stmt, binding)


def _js_try_arms(stmt: str) -> tuple[list[str], str]:
    """The try statement's try / catch blocks and its finally block ("" when there is none)."""
    blocks, at = [], 0
    for m in re.finditer(r"(try|catch\s*(\([^)]*\))?|finally)\s*(?=\{)", stmt):
        if m.start() < at:
            continue
        open_at = stmt.index("{", m.end())
        close_at = _close(stmt, open_at, "{", "}")
        blocks.append((m.group(1).startswith("finally"), stmt[open_at + 1:close_at - 1]))
        at = close_at
    return [body for final, body in blocks if not final], next((body for final, body in blocks if final), "")


def _js_flow(code: str, binding: str) -> str:
    """How the paths through the block end -- RECORDED, SILENT or OPEN, the rule of _py_flow."""
    for stmt in _js_statements(code):
        if _js_statement_records(stmt, binding):
            return RECORDED
        head = _head(stmt)
        if head in ("return", "break", "continue"):
            return SILENT
        if head == "if":
            arms = _js_if_arms(stmt)
        elif head == "try":
            arms, final = _js_try_arms(stmt)
            if final and _js_flow(final, binding) == RECORDED:
                return RECORDED
        elif head in ("for", "while", "do", "switch"):
            # the body may not run, so it never settles the block; a return from inside it leaves unrecorded
            if re.search(r"(?<![\w$.])return(?![\w$])", stmt):
                return SILENT
            continue
        else:
            continue
        flows = [_js_flow(arm, binding) for arm in arms]
        if SILENT in flows:
            return SILENT
        if all(flow == RECORDED for flow in flows):
            return RECORDED
    return OPEN


def silent(kind: str, body: str, whole: str, binding: str = "", following=()) -> bool:
    """A handler with a path out of it that leaves no record: that path neither records the failure, nor re-throws,
    nor hands the error object on, and no `not an error:` comment states why it is not an error. Reading or
    formatting the error, or recording it only under a condition, is not a record. A `catch` block that falls off
    its end is judged with the code that runs next in the same function (`following`, innermost block first)."""
    if ANNOTATION.search(whole):
        return False
    code = _COMMENTS.sub("", body).strip()
    if kind == "arrow-expr":
        return not _js_statement_records(code, binding)
    flow = _js_flow(code, binding)
    if kind == "block":
        for rest in following:
            if flow != OPEN:
                break
            flow = _js_flow(_COMMENTS.sub("", rest), "")
    return flow != RECORDED


def _js_braces(text: str) -> dict[int, int]:
    """Each closing brace's opening brace, skipping strings, templates and comments."""
    pairs, stack, i, n = {}, [], 0, len(text)
    while i < n:
        ch = text[i]
        if ch in "\"'`":
            i = _skip_string(text, i)
            continue
        if text.startswith("//", i):
            i = text.find("\n", i)
            i = n if i < 0 else i
            continue
        if text.startswith("/*", i):
            i = text.find("*/", i)
            i = n if i < 0 else i + 2
            continue
        if ch == "{":
            stack.append(i)
        elif ch == "}" and stack:
            pairs[i] = stack.pop()
        i += 1
    return pairs


def _js_following(text: str, end: int, pairs: dict[int, int]):
    """The code that runs after the statement ending at `end`: the rest of each enclosing block, up to the function."""
    opens = {o: c for c, o in pairs.items()}
    while True:
        close = min((c for c, o in pairs.items() if o < end <= c), default=None)
        if close is None:
            return
        rest = text[end:close]
        finally_block = re.match(r"\s*finally\s*\{", rest)
        if finally_block:
            fin_open = end + finally_block.end() - 1
            yield text[fin_open + 1:opens[fin_open]]
            rest = text[opens[fin_open] + 1:close]
        yield rest
        before = text[:pairs[close]].rstrip()
        if before.endswith(")"):
            depth, j = 0, len(before) - 1
            while j >= 0:
                depth += {")": 1, "(": -1}.get(before[j], 0)
                if depth == 0:
                    break
                j -= 1
            if not re.search(r"(?<![\w$.])(if|for|while|switch|catch)\s*$", before[:j]):
                return
        elif not re.search(r"(?<![\w$.])(else|try|finally|do)$", before):
            return
        end = close + 1


def scan_js(path: Path) -> list[tuple[int, str]]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    lines = text.splitlines()
    pairs = _js_braces(text)
    found = []
    for start, end, kind, binding, body in js_handlers(text):
        # the handler and the rest of the line its closing brace is on (where a short handler's comment goes)
        line_end = text.find("\n", end)
        whole = text[start:len(text) if line_end < 0 else line_end]
        if silent(kind, body, whole, binding, _js_following(text, end, pairs) if kind == "block" else ()):
            line = text.count("\n", 0, start) + 1
            found.append((line, lines[line - 1].strip()[:140]))
    return sorted(found)


_PY_RECORDING = re.compile(r"(?i)(log|warn|error|exception|critical|info|debug|record|report|emit|fail|print|remediat)")


# Builtins that only inspect or format the exception: passing it to them does not hand the failure on.
_PY_INSPECTING = {"str", "repr", "format", "isinstance", "issubclass", "type", "getattr", "hasattr", "len", "bool",
                  "int", "id", "vars"}


def _py_parents(root: ast.AST) -> dict[ast.AST, ast.AST]:
    return {child: parent for parent in ast.walk(root) for child in ast.iter_child_nodes(parent)}


def _py_hands_on(name: ast.Name, parents: dict[ast.AST, ast.AST]) -> bool:
    """The exception object itself leaves the handler: returned, stored, yielded, put in a container or passed to a
    call. Reading an attribute, comparing, formatting or passing it to an inspecting builtin does not."""
    parent = parents.get(name)
    while isinstance(parent, (ast.Tuple, ast.List, ast.Set, ast.Dict, ast.Starred)):
        name, parent = parent, parents.get(parent)
    if isinstance(parent, (ast.Return, ast.Yield, ast.YieldFrom, ast.Assign, ast.AnnAssign, ast.keyword)):
        return True
    if isinstance(parent, ast.Call) and name is not parent.func:
        func = parent.func
        called = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
        return called not in _PY_INSPECTING
    return False


def _py_statement_records(stmt: ast.stmt, handler: ast.ExceptHandler, parents: dict[ast.AST, ast.AST]) -> bool:
    """`stmt` records, raises or hands the exception on whenever it runs (nested functions do not run here)."""
    stack = [stmt]
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        if isinstance(node, (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.BoolOp, ast.Match)):
            continue   # conditional: judged arm by arm in _py_flow
        if isinstance(node, ast.Raise):
            return True
        if handler.name and isinstance(node, ast.Name) and node.id == handler.name and _py_hands_on(node, parents):
            return True
        if isinstance(node, ast.Call):
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
            if _PY_RECORDING.search(name):
                return True
        stack.extend(ast.iter_child_nodes(node))
    return False


_PY_EXITS = (ast.Return, ast.Break, ast.Continue)
_PY_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef, ast.Module)


def _py_flow(body: list[ast.stmt], handler: ast.ExceptHandler, parents: dict[ast.AST, ast.AST]) -> str:
    """How the paths through `body` end: RECORDED when every path records, raises or hands the exception on; SILENT
    when some path leaves (return / break / continue) without that; OPEN when some path reaches the end without it.

    A branch (if / match / loop / try) settles the block only when all of its arms do; a loop body may not run."""
    for stmt in body:
        if _py_statement_records(stmt, handler, parents):
            return RECORDED
        if isinstance(stmt, _PY_EXITS):
            return SILENT
        if isinstance(stmt, ast.If):
            arms = [stmt.body, stmt.orelse]
        elif isinstance(stmt, ast.Match):
            arms = [case.body for case in stmt.cases]
            if not any(isinstance(case.pattern, ast.MatchAs) and case.pattern.pattern is None for case in stmt.cases):
                arms.append([])
        elif isinstance(stmt, ast.Try):
            if stmt.finalbody and _py_flow(stmt.finalbody, handler, parents) == RECORDED:
                return RECORDED
            arms = [stmt.body + stmt.orelse] + [h.body for h in stmt.handlers]
        elif isinstance(stmt, (ast.With, ast.AsyncWith)):
            arms = [stmt.body]
        elif isinstance(stmt, (ast.For, ast.AsyncFor, ast.While)):
            arms = [stmt.body, []]
        else:
            continue
        flows = [_py_flow(arm, handler, parents) for arm in arms]
        if SILENT in flows:
            return SILENT
        if all(flow == RECORDED for flow in flows):
            return RECORDED
    return OPEN


def _py_following(node: ast.AST, parents: dict[ast.AST, ast.AST]):
    """The statements that run after `node` finishes normally, one enclosing block at a time, up to the function."""
    while not isinstance(node, _PY_SCOPES):
        parent = parents.get(node)
        if parent is None:
            return
        for field in ("body", "orelse", "finalbody"):
            block = getattr(parent, field, None)
            if isinstance(block, list) and node in block:
                yield block[block.index(node) + 1:]
                break
        node = parent


def _py_records(handler: ast.ExceptHandler, parents: dict[ast.AST, ast.AST]) -> bool:
    """Every path out of the handler records: inside it, or -- when it falls off its end -- in the code that runs next
    in the same function (a function that then ends without a record returns silently)."""
    flow = _py_flow(handler.body, handler, parents)
    if flow != OPEN:
        return flow == RECORDED
    try_node = parents.get(handler)
    if isinstance(try_node, ast.Try) and try_node.finalbody:
        flow = _py_flow(try_node.finalbody, handler, parents)
        if flow != OPEN:
            return flow == RECORDED
    for rest in _py_following(try_node, parents):
        flow = _py_flow(rest, handler, parents)
        if flow != OPEN:
            return flow == RECORDED
    return False


def scan_py(path: Path) -> list[tuple[int, str]]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    lines = text.splitlines()
    try:
        tree = ast.parse(text)
    except SyntaxError as exc:  # not an error: an unparsable file is listed as a finding, which fails the check
        return [(exc.lineno or 1, f"cannot parse: {exc.msg}")]
    found = []
    parents = _py_parents(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.ExceptHandler):
            continue
        end = max((getattr(n, "end_lineno", node.lineno) or node.lineno) for n in node.body) if node.body else node.lineno
        # the except line, the handler's own lines and a comment right above its first statement
        span = "\n".join(lines[node.lineno - 1:end])
        if ANNOTATION.search(span):
            continue
        if _py_records(node, parents):
            continue
        found.append((node.lineno, lines[node.lineno - 1].strip()[:140]))
    return found


def scan() -> list[tuple[str, int, str]]:
    results = []
    for path in _files(JS_DIRS, (".js", ".mjs", ".cjs")):
        results += [(str(path.relative_to(ROOT)).replace("\\", "/"), n, s) for n, s in scan_js(path)]
    for path in _files(PY_DIRS, (".py",)):
        results += [(str(path.relative_to(ROOT)).replace("\\", "/"), n, s) for n, s in scan_py(path)]
    return sorted(results)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--count", action="store_true")
    args = parser.parse_args()
    results = scan()
    if args.count:
        print(len(results))
    else:
        for path, line, source in results:
            print(f"{path}:{line}: {source}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
