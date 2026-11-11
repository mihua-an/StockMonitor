"""cssdead.py [--fix] -- CSS rules under ui/ whose selectors name a class or id no JS/HTML produces.

A class counts as produced when its name appears in any ui JS/HTML file, or a prefix of it ending in '-' or '_'
appears followed by a template/concatenation (`prefix-${`, "prefix-" +). A selector list keeps the selectors that
are produced; a rule whose every selector is dead is removed. @keyframes / @font-face blocks are left alone."""
import glob
import os
import re
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
FIX = '--fix' in sys.argv
code_files = [f for f in glob.glob('ui/**/*', recursive=True) if f.endswith(('.js', '.html', '.mjs')) and 'node_modules' not in f]
code = '\n'.join(open(f, encoding='utf-8', errors='ignore').read() for f in code_files)
dynamic_prefixes = set(re.findall(r'([A-Za-z][\w-]*[-_])(?:\$\{|["\'`]\s*\+)', code))
known_cache = {}


def produced(token):
    if token in known_cache:
        return known_cache[token]
    ok = re.search(r'(?<![\w-])' + re.escape(token) + r'(?![\w-])', code) is not None
    if not ok:
        ok = any(token.startswith(p) for p in dynamic_prefixes)
    known_cache[token] = ok
    return ok


def selector_alive(sel):
    names = re.findall(r'[.#]([A-Za-z_][\w-]*)', re.sub(r'\[[^\]]*\]', '', re.sub(r':not\([^)]*\)', '', sel)))
    return all(produced(n) for n in names)


def process(text, report):
    out, i, n = [], 0, len(text)
    while i < n:
        j = text.find('{', i)
        if j < 0:
            out.append(text[i:])
            break
        head = text[i:j]
        # find matching brace
        depth, k = 0, j
        while k < n:
            if text[k] == '{':
                depth += 1
            elif text[k] == '}':
                depth -= 1
                if depth == 0:
                    break
            k += 1
        body = text[j + 1:k]
        prelude = head.strip()
        lead = head[:len(head) - len(head.lstrip())]
        comment_split = prelude.rfind('*/')
        comment = prelude[:comment_split + 2] if comment_split >= 0 else ''
        selector_text = prelude[comment_split + 2:].strip() if comment_split >= 0 else prelude
        if selector_text.startswith('@media') or selector_text.startswith('@supports') or selector_text.startswith('@container'):
            out.append(head + '{' + process(body, report) + '}')
        elif selector_text.startswith('@') or not selector_text:
            out.append(head + '{' + body + '}')
        else:
            selectors = [s.strip() for s in selector_text.split(',')]
            alive = [s for s in selectors if selector_alive(s)]
            if len(alive) == len(selectors):
                out.append(head + '{' + body + '}')
            elif alive:
                report.append(('partial', [s for s in selectors if s not in alive]))
                new_head = lead + (comment + '\n' if comment else '') + ',\n'.join(alive) + ' '
                out.append(new_head + '{' + body + '}')
            else:
                report.append(('rule', selectors))
                if comment:
                    out.append(lead + comment)
        i = k + 1
    return ''.join(out)


total_rules = total_sel = 0
for css in sorted(glob.glob('ui/**/*.css', recursive=True)):
    text = open(css, encoding='utf-8').read()
    report = []
    new = process(text, report)
    rules = sum(1 for kind, _ in report if kind == 'rule')
    sels = sum(len(s) for _, s in report)
    total_rules += rules
    total_sel += sels
    print(f'{css}: {rules} dead rules, {sels} dead selectors')
    for kind, s in report[:6]:
        print('   ', kind, s[:3])
    if FIX and new != text:
        new = re.sub(r'\n{3,}', '\n\n', new)
        open(css, 'w', encoding='utf-8', newline='').write(new)
print('total', total_rules, total_sel)
