"""Remove dead CSS that the cascade itself proves dead, across the stylesheets index.css imports (in cascade order).

Three transformations, each one leaves every element's computed style unchanged:

1. A declaration is dropped when, for every selector of its list, a LATER rule containing that identical selector, in a
   context that always applies where the earlier one does, sets the same property (same elements, same specificity,
   later wins; the project has no !important).
2. Two rules with the identical selector list and @media context are merged into the later one when nothing in
   between could have depended on their order: no rule between them sets a property of the same family (a shorthand
   and its longhands are one family) with a selector of equal specificity. The earlier declarations go first in the
   merged block, so their order relative to the later block's own declarations is kept.
3. A rule left with no declarations is removed.

Anything that needs the DOM to decide (a different selector that always matches the same elements) is not touched.

Usage: python -m scripts.qa.css_dedupe [--write] [--report]
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

STYLES = Path(__file__).resolve().parents[2] / "ui" / "renderer" / "styles"


# ----------------------------------------------------------------------------------------------- parsing
@dataclass
class Decl:
    prop: str
    text: str            # the declaration as written (no trailing ;)
    start: int           # offsets in the file (start of the declaration text, end after its ';' if any)
    end: int


@dataclass
class Rule:
    file: Path
    selector: str        # normalized selector list
    media: tuple[str, ...]
    start: int           # offset of the selector start
    body_start: int      # offset after '{'
    body_end: int        # offset of '}'
    end: int             # offset after '}'
    decls: list[Decl] = field(default_factory=list)
    order: int = 0


def _skip_comment(text: str, i: int) -> int:
    end = text.find("*/", i + 2)
    return len(text) if end < 0 else end + 2


def _match_brace(text: str, i: int) -> int:
    """Index of the '}' closing the '{' at i (comments and strings skipped)."""
    depth = 0
    n = len(text)
    while i < n:
        c = text[i]
        if text.startswith("/*", i):
            i = _skip_comment(text, i)
            continue
        if c in "\"'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            i = j + 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("unbalanced braces")


def _norm_selector(sel: str) -> str:
    sel = re.sub(r"/\*.*?\*/", "", sel, flags=re.S)
    parts = [" ".join(p.split()) for p in _split_top(sel, ",")]
    return ", ".join(p for p in parts if p)


def _split_top(text: str, sep: str) -> list[str]:
    out, depth, cur = [], 0, []
    for c in text:
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        if c == sep and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(c)
    out.append("".join(cur))
    return out


def _parse_decls(text: str, start: int, end: int) -> list[Decl]:
    decls = []
    i = start
    while i < end:
        # skip whitespace and comments
        while i < end and (text[i].isspace() or text.startswith("/*", i)):
            i = _skip_comment(text, i) if text.startswith("/*", i) else i + 1
        if i >= end:
            break
        j = i
        depth = 0
        while j < end:
            c = text[j]
            if text.startswith("/*", j):
                j = _skip_comment(text, j)
                continue
            if c in "\"'":
                k = j + 1
                while k < end and text[k] != c:
                    k += 2 if text[k] == "\\" else 1
                j = k + 1
                continue
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            elif c == ";" and depth == 0:
                break
            j += 1
        decl_text = text[i:j].strip()
        stop = j + 1 if j < end else j
        if ":" in decl_text:
            prop = decl_text.split(":", 1)[0].strip().lower()
            decls.append(Decl(prop=prop, text=decl_text, start=i, end=stop))
        i = stop
    return decls


def parse(file: Path) -> tuple[str, list[Rule]]:
    text = file.read_text(encoding="utf-8")
    rules: list[Rule] = []

    def walk(start: int, end: int, media: tuple[str, ...]) -> None:
        i = start
        while i < end:
            if text[i].isspace():
                i += 1
                continue
            if text.startswith("/*", i):
                i = _skip_comment(text, i)
                continue
            brace = text.find("{", i)
            semi = text.find(";", i)
            if text[i] == "@" and (semi != -1 and (brace == -1 or semi < brace)):
                i = semi + 1            # @import / @charset
                continue
            if brace == -1 or brace >= end:
                break
            close = _match_brace(text, brace)
            head = text[i:brace]
            if head.lstrip().startswith("@"):
                at = " ".join(re.sub(r"/\*.*?\*/", "", head, flags=re.S).split())
                if at.startswith("@media") or at.startswith("@supports") or at.startswith("@layer"):
                    walk(brace + 1, close, media + (at,))
                # @keyframes / @font-face: left alone
            else:
                rule = Rule(file=file, selector=_norm_selector(head), media=media, start=i,
                            body_start=brace + 1, body_end=close, end=close + 1)
                rule.decls = _parse_decls(text, brace + 1, close)
                rules.append(rule)
            i = close + 1

    walk(0, len(text), ())
    return text, rules


def cascade_files() -> list[Path]:
    """index.css's @import order (then the window stylesheets, which no page loads together with index.css)."""
    index = (STYLES / "index.css").read_text(encoding="utf-8")
    files = [STYLES / m for m in re.findall(r'@import\s+(?:url\()?["\']?([^"\')]+)["\']?\)?', index)]
    return [f for f in files if f.exists()]


# ----------------------------------------------------------------------------------------------- specificity
def _specificity(sel: str) -> tuple[int, int, int]:
    a = b = c = 0
    s = sel
    # functional pseudo-classes
    def take_args(s: str, start: int) -> tuple[str, int]:
        depth, j = 0, start
        while j < len(s):
            if s[j] == "(":
                depth += 1
            elif s[j] == ")":
                depth -= 1
                if depth == 0:
                    return s[start + 1:j], j + 1
            j += 1
        return s[start + 1:], len(s)

    i = 0
    out = []
    while i < len(s):
        m = re.match(r":(where|is|not|has)\(", s[i:])
        if m:
            name = m.group(1)
            args, nxt = take_args(s, i + len(m.group(0)) - 1)
            if name != "where":
                best = max((_specificity(x.strip()) for x in _split_top(args, ",")), default=(0, 0, 0))
                a, b, c = a + best[0], b + best[1], c + best[2]
            out.append(" ")
            i = nxt
            continue
        out.append(s[i])
        i += 1
    rest = "".join(out)
    rest = re.sub(r"\[[^\]]*\]", lambda m: (" .attr ") , rest)
    a += len(re.findall(r"#[\w-]+", rest))
    b += len(re.findall(r"\.[\w-]+", rest))
    pseudo_el = len(re.findall(r"::[\w-]+", rest))
    rest2 = re.sub(r"::[\w-]+", " ", rest)
    b += len(re.findall(r":[\w-]+(\([^)]*\))?", rest2))
    rest3 = re.sub(r"[#.:][\w-]+(\([^)]*\))?", " ", rest2)
    c += pseudo_el + len([t for t in re.findall(r"(?<![\w-])[a-zA-Z][\w-]*", rest3) if t not in ("attr",)])
    return (a, b, c)


def specificities(selector_list: str) -> set[tuple[int, int, int]]:
    return {_specificity(s.strip()) for s in _split_top(selector_list, ",") if s.strip()}


SHORTHAND_GROUPS = [{"inset", "top", "right", "bottom", "left"}, {"gap", "row-gap", "column-gap"},
                    {"place-items", "align-items", "justify-items"}, {"place-content", "align-content", "justify-content"},
                    {"place-self", "align-self", "justify-self"}]


def family(prop: str) -> frozenset[str] | str:
    for group in SHORTHAND_GROUPS:
        if prop in group:
            return frozenset(group)
    return prop.split("-", 1)[0] if not prop.startswith("--") else prop


def same_family(p: str, q: str) -> bool:
    fp, fq = family(p), family(q)
    if isinstance(fp, frozenset) or isinstance(fq, frozenset):
        return (fp == fq) or (isinstance(fp, frozenset) and q in fp) or (isinstance(fq, frozenset) and p in fq) or p == q
    return fp == fq


# ----------------------------------------------------------------------------------------------- analysis
def analyse(files: list[Path]):
    texts: dict[Path, str] = {}
    rules: list[Rule] = []
    for f in files:
        text, file_rules = parse(f)
        texts[f] = text
        rules.extend(file_rules)
    for n, r in enumerate(rules):
        r.order = n
    # declarations to delete (Decl objects) and merges (earlier rule -> later rule)
    dead: dict[int, set[int]] = {}       # rule order -> indexes of decls to delete
    by_key: dict[tuple[str, tuple[str, ...]], list[Rule]] = {}
    for r in rules:
        by_key.setdefault((r.selector, r.media), []).append(r)
    for group in by_key.values():
        for i, r in enumerate(group):
            later_props = {d.prop for later in group[i + 1:] for d in later.decls}
            for k, d in enumerate(r.decls):
                if d.prop in later_props:
                    dead.setdefault(r.order, set()).add(k)
            # within one rule: an earlier duplicate of the same property is dead too
            seen: dict[str, int] = {}
            for k, d in enumerate(r.decls):
                if d.prop in seen:
                    dead.setdefault(r.order, set()).add(seen[d.prop])
                seen[d.prop] = k
    # Branch by branch: a declaration is dead when EVERY selector of its list appears again, identical, in a LATER
    # rule (any list it is part of) that sets the same property in a context that always applies where it does -- the
    # same @media/@supports/@layer context, or none at all when the earlier one is not in a layer (an unlayered rule
    # beats a layered one whatever the order). Same selector = same elements and same specificity: the later wins.
    setters: dict[tuple[str, str], list[Rule]] = {}
    for r in rules:
        for part in _split_top(r.selector, ","):
            part = part.strip()
            if part:
                for d in r.decls:
                    setters.setdefault((part, d.prop), []).append(r)

    def overrides(later: Rule, earlier: Rule) -> bool:
        if later.order <= earlier.order:
            return False
        return later.media == earlier.media or (not later.media and not any(m.startswith("@layer") for m in earlier.media))

    for r in rules:
        parts = [p.strip() for p in _split_top(r.selector, ",") if p.strip()]
        for k, d in enumerate(r.decls):
            if k in dead.get(r.order, set()) or not parts:
                continue
            if all(any(overrides(x, r) for x in setters.get((p, d.prop), [])) for p in parts):
                dead.setdefault(r.order, set()).add(k)
    merges: list[tuple[Rule, Rule]] = []
    for group in by_key.values():
        if len(group) < 2:
            continue
        target = group[-1]
        if any(r.file != target.file for r in group):
            continue   # merging across files would move a rule to another owner's stylesheet
        spec = specificities(target.selector)
        for r in group[:-1]:
            remaining = [d for k, d in enumerate(r.decls) if k not in dead.get(r.order, set())]
            between = [x for x in rules if r.order < x.order < target.order]
            blocked = False
            for d in remaining:
                for x in between:
                    if specificities(x.selector) & spec and any(same_family(d.prop, y.prop) for y in x.decls):
                        blocked = True
                        break
                if blocked:
                    break
            if not blocked:
                merges.append((r, target))
    return texts, rules, dead, merges


def _comment_above(text: str, line_start: int) -> tuple[int, str]:
    """The comment block ending on the line just above `line_start` (no blank line between), with its own lines."""
    head = text[:line_start]
    stripped = head.rstrip(" \t")
    if not stripped.endswith("\n"):
        return line_start, ""
    body = stripped[:-1]
    if not body.rstrip().endswith("*/") or body.endswith("\n"):
        return line_start, ""
    open_at = body.rfind("/*")
    if open_at < 0:
        return line_start, ""
    begin = text.rfind("\n", 0, open_at) + 1
    if text[begin:open_at].strip():
        return line_start, ""
    return begin, text[begin:line_start]


def apply(texts, rules, dead, merges) -> dict[Path, str]:
    merged_into: dict[int, list[Rule]] = {}
    merged_from: set[int] = set()
    for src, dst in merges:
        merged_into.setdefault(dst.order, []).append(src)
        merged_from.add(src.order)
    out: dict[Path, str] = {}
    target_of = {src.order: dst for src, dst in merges}
    for f, text in texts.items():
        edits: list[tuple[int, int, str]] = []
        for r in [x for x in rules if x.file == f]:
            keep = [d for k, d in enumerate(r.decls) if k not in dead.get(r.order, set())]
            if r.order in merged_from or not keep:
                # The whole rule goes (its live declarations move to the later block), with the comment written
                # directly above it: a rule merged away takes that comment to its new block, a rule left empty
                # (every declaration dead) drops it with the dead declarations it described.
                start = text.rfind("\n", 0, r.start) + 1
                if text[start:r.start].strip():
                    start = r.start
                comment_start, comment = _comment_above(text, start)
                end = r.end
                while end < len(text) and text[end] in " \t":
                    end += 1
                if end < len(text) and text[end] == "\n":
                    end += 1
                edits.append((comment_start, end, ""))
                target = target_of.get(r.order)
                if comment and target is not None and keep:
                    line_start = text.rfind("\n", 0, target.start) + 1
                    edits.append((line_start, line_start, comment))
                continue
            moved = [d for src in merged_into.get(r.order, []) for k, d in enumerate(src.decls)
                     if k not in dead.get(src.order, set())]
            for k, d in enumerate(r.decls):
                if k in dead.get(r.order, set()):
                    edits.append((d.start, d.end, ""))
            if moved:
                body = text[r.body_start:r.body_end]
                multiline = "\n" in body
                indent = re.search(r"\n([ \t]+)\S", body)
                pad = indent.group(1) if indent else "  "
                if multiline:
                    insert = "".join(f"\n{pad}{d.text};" for d in moved)
                    edits.append((r.body_start, r.body_start, insert))
                else:
                    insert = " " + " ".join(f"{d.text};" for d in moved)
                    edits.append((r.body_start, r.body_start, insert))
        new = text
        for start, end, repl in sorted(edits, key=lambda e: (e[0], e[1]), reverse=True):
            new = new[:start] + repl + new[end:]
        # tidy: lines left holding only the indent of a removed declaration, blank lines opening or closing a block,
        # and runs of blank lines
        new = re.sub(r"(?m)^[ \t]+\n", "", new)
        new = re.sub(r"\{[ \t]*\n(?:[ \t]*\n)+", "{\n", new)
        new = re.sub(r"\n(?:[ \t]*\n)+(?=[ \t]*\})", "\n", new)
        new = re.sub(r"\n{3,}", "\n\n", new)
        out[f] = new
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write", action="store_true", help="rewrite the stylesheets")
    parser.add_argument("--file", action="append", help="only these stylesheets (relative to styles/)")
    args = parser.parse_args(argv)
    files = cascade_files()
    texts, rules, dead, merges = analyse(files)
    only = {STYLES / f for f in (args.file or [])}
    dead_count = sum(len(v) for k, v in dead.items() if not only or rules[k].file in only)
    merge_count = sum(1 for s, _d in merges if not only or s.file in only)
    print(f"{len(files)} stylesheets, {len(rules)} rules: {dead_count} dead declarations, {merge_count} merges")
    for src, dst in merges:
        if only and src.file not in only:
            continue
        print(f"  merge {src.file.relative_to(STYLES)}: '{src.selector}' -> line of later block")
    if args.write:
        new = apply(texts, rules, dead, merges)
        for f, text in new.items():
            if only and f not in only:
                continue
            if text != texts[f]:
                f.write_text(text, encoding="utf-8")
                print(f"  wrote {f.relative_to(STYLES)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
