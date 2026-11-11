// A component's markup has exactly one producer: its shell function. Pages ship empty slots; a host that already
// holds markup when a component mounts (a slot kept across a page switch, a component mounted again into the shell
// it left behind) keeps that markup only when it is the same shell: the same root class and every data-role the
// shell produces. Anything else -- a partial copy, another component's shell -- is rebuilt from the shell, so the
// live DOM is always what the shell function builds. Ids are never part of a shell; a component assigns them after
// mount.

const shellFactsCache = new Map();

// The shell's root class and roles, read from its markup (a shell is this code's own template string).
function shellFacts(markup) {
  let facts = shellFactsCache.get(markup);
  if (!facts) {
    facts = {
      rootClass: (String(markup).match(/^\s*<[a-z]+[^>]*?\sclass="([^"\s]+)/i) || [])[1] || "",
      roles: [...new Set([...String(markup).matchAll(/\sdata-role="([^"]+)"/g)].map((match) => match[1]))],
    };
    shellFactsCache.set(markup, facts);
  }
  return facts;
}

/** Whether `host` holds the shell `markup` builds (its root class and all of its roles). */
export function holdsShell(host, markup) {
  const { rootClass, roles } = shellFacts(markup);
  const root = host?.firstElementChild;
  if (!root || (rootClass && !root.classList?.contains(rootClass))) return false;
  return roles.every((name) => host.querySelector(`[data-role="${name}"]`));
}

/**
 * Give `host` the shell `markup`. With `hydrate`, markup the host already holds is kept when it is this shell;
 * otherwise (or without `hydrate`) the host is rebuilt. Returns true when the shell was (re)built.
 */
export function mountShell(host, markup, { hydrate = false } = {}) {
  if (hydrate && holdsShell(host, markup)) return false;
  host.innerHTML = markup;
  return true;
}

/** The first element `markup` builds, detached (to put one part of a shell in place of an outdated one). */
export function shellElement(markup) {
  const holder = document.createElement("div");
  holder.innerHTML = String(markup || "").trim();
  return holder.firstElementChild;
}
