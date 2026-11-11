// Page navigation, one at a time and newest wins. A navigation requested while another runs waits for it; a queued
// one that a newer request superseded never runs, and a running one is told (isCurrent) so it can stop at a checkpoint
// before it commits its page. `run(page, options, isCurrent)` does the navigation itself.

export function createNavigationCoordinator(run) {
  let chain = Promise.resolve();
  let latest = 0;
  return {
    navigate(page, options = {}) {
      const token = ++latest;
      const isCurrent = () => token === latest;
      const step = chain.then(() => (isCurrent() ? run(page, options, isCurrent) : { superseded: true }));
      chain = step.catch(() => { /* not an error: the navigation's own caller receives and records its failure */ });
      return step;
    },
  };
}
