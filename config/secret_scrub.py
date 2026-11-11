"""Finding secrets in names and values (config/secret_scrub.json holds the rules and their exact wording).

``secret_name`` decides a key; ``secret_spans`` finds the secret parts of a string (a query parameter, a form field, an
``Authorization`` line, a quoted JSON field inside a message, a bare ``Bearer`` value, a JSON Web Token, a PEM private
key); ``scrub_text`` replaces them; ``scrub_value`` walks a structure dropping secret keys and scrubbing every string;
``secret_paths`` lists where a structure holds one (a saved config revision is refused on any).

config/js/secret_scrub.js and the scrub module of native/market_runtime/src/remediation.rs implement the same rules;
tests/fixtures/secret_scrub_cases.json holds the cases all three must agree on.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Collection, Mapping

RULES_PATH = Path(__file__).resolve().parent / "secret_scrub.json"
_RULES: dict[str, Any] = json.loads(RULES_PATH.read_text(encoding="utf-8"))
_MARKERS: tuple[str, ...] = tuple(_RULES["key_markers"])
_EXACT = frozenset(_RULES["exact_names"])
_AUTH_SCHEMES = frozenset(_RULES["auth_schemes"])
_BARE_SCHEMES: tuple[str, ...] = tuple(_RULES["bare_schemes"])
_PEM_MARKER: str = _RULES["pem_marker"]
REDACTED: str = _RULES["redacted"]
MAX_DEPTH: int = int(_RULES["max_depth"])

_ALNUM = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
_NAME = _ALNUM | frozenset("_.-")
_JWT = _ALNUM | frozenset("_-")
_SPACES = frozenset(" \t")
_WHITESPACE = frozenset(" \t\r\n\f\v")
_QUOTES = frozenset("\"'")
_VALUE_STOP = _WHITESPACE | frozenset("\"'&;,()[]{}<>")


def secret_name(name: Any) -> bool:
    normalized = "".join(c for c in str(name).upper() if "A" <= c <= "Z" or "0" <= c <= "9")
    return normalized in _EXACT or any(marker in normalized for marker in _MARKERS)


def _skip(text: str, at: int, chars: frozenset[str]) -> int:
    while at < len(text) and text[at] in chars:
        at += 1
    return at


def _run_end(text: str, at: int) -> int:
    while at < len(text) and text[at] not in _VALUE_STOP:
        at += 1
    return at


def _named_value(text: str, name_end: int) -> tuple[int, int] | None:
    """The secret after a secret name ending at ``name_end`` (rule 1), or None."""
    at = name_end + 1 if name_end < len(text) and text[name_end] in _QUOTES else name_end
    at = _skip(text, at, _SPACES)
    if at >= len(text) or text[at] not in "=:":
        return None
    at = _skip(text, at + 1, _SPACES)
    if at < len(text) and text[at] in _QUOTES:
        at += 1
    end = _run_end(text, at)
    if end == at:
        return None
    if text[at:end].upper() in _AUTH_SCHEMES:
        after = _skip(text, end, _SPACES)
        final = _run_end(text, after) if after > end else after
        return (after, final) if final > after else (end, end)
    return at, end


def secret_spans(text: str) -> list[tuple[int, int]]:
    """The merged [start, end) spans of ``text`` that are secret."""
    if _PEM_MARKER in text:
        return [(0, len(text))] if text else []
    spans: list[tuple[int, int]] = []
    size = len(text)
    at = 0
    while at < size:
        if text[at] in _NAME and (at == 0 or text[at - 1] not in _NAME):
            end = _skip(text, at, _NAME)
            found = _named_value(text, end) if secret_name(text[at:end]) else None
            if found is not None and found[1] > found[0]:
                spans.append(found)
                at = found[1]
            else:
                at = end
            continue
        at += 1
    for scheme in _BARE_SCHEMES:
        for start in range(size - len(scheme)):
            after = start + len(scheme)
            if (text[after] in _SPACES and text[start:after].upper() == scheme
                    and (start == 0 or text[start - 1] not in _ALNUM)):
                value = _skip(text, after, _SPACES)
                end = _run_end(text, value)
                if end > value:
                    spans.append((value, end))
    start = text.find("eyJ")
    while start != -1:
        if start == 0 or text[start - 1] not in _JWT:
            first = _skip(text, start + 3, _JWT)
            if first > start + 3 and first < size and text[first] == ".":
                second = _skip(text, first + 1, _JWT)
                if second > first + 1 and second < size and text[second] == ".":
                    spans.append((start, _skip(text, second + 1, _JWT)))
        start = text.find("eyJ", start + 1)
    merged: list[tuple[int, int]] = []
    for span in sorted(spans):
        if merged and span[0] < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], span[1]))
        else:
            merged.append(span)
    return merged


def scrub_text(text: str) -> str:
    out: list[str] = []
    cursor = 0
    for start, end in secret_spans(text):
        out.append(text[cursor:start])
        out.append(REDACTED)
        cursor = end
    out.append(text[cursor:])
    return "".join(out)


def scrub_value(value: Any, depth: int = 0) -> Any:
    """``value`` with every secret key dropped and every string scrubbed; a container at ``MAX_DEPTH`` is ``REDACTED``."""
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, Mapping) or isinstance(value, (list, tuple)):
        if depth >= MAX_DEPTH:
            return REDACTED
        if isinstance(value, Mapping):
            return {str(key): scrub_value(item, depth + 1) for key, item in value.items() if not secret_name(key)}
        return [scrub_value(item, depth + 1) for item in value]
    return value


def secret_paths(value: Any, prefix: str = "", *, allowed_names: Collection[str] = (), depth: int = 0) -> list[str]:
    """Where ``value`` holds a secret: a secret key (unless listed in ``allowed_names``), a string with a secret span, or
    a container nested beyond ``MAX_DEPTH`` (it cannot be checked)."""
    if isinstance(value, str):
        return [prefix] if secret_spans(value) else []
    if not (isinstance(value, Mapping) or isinstance(value, (list, tuple))):
        return []
    if depth >= MAX_DEPTH:
        return [prefix]
    found: list[str] = []
    if isinstance(value, Mapping):
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if secret_name(key) and str(key) not in allowed_names:
                found.append(path)
            else:
                found.extend(secret_paths(item, path, allowed_names=allowed_names, depth=depth + 1))
    else:
        for index, item in enumerate(value):
            found.extend(secret_paths(item, f"{prefix}[{index}]", allowed_names=allowed_names, depth=depth + 1))
    return found
