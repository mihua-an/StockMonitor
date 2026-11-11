"use strict";

// A process whose stdout/stderr reader has gone away (the terminal or parent that launched it closed its end of the
// pipe) gets EPIPE on its next console line. Node's console swallows the synchronous part of a failed write, but the
// stream then emits "error" asynchronously; with no listener that is an uncaught exception, which in Electron main is
// the "A JavaScript error occurred in the main process" dialog -- caused by nothing but a log line.
//
// installStdioGuard() gives each stream a permanent "error" listener. The first failure per stream is handed to
// onLost (which must not write to that stream: the caller records it in a file); later failures of the same stream
// are the same lost reader and are only counted. The console keeps working for the other stream.

function installStdioGuard({ onLost, streams = { stdout: process.stdout, stderr: process.stderr } } = {}) {
  const state = {};
  for (const [name, stream] of Object.entries(streams)) {
    if (!stream || typeof stream.on !== "function") continue;
    state[name] = { lost: false, failures: 0 };
    stream.on("error", (error) => {
      const entry = state[name];
      entry.failures += 1;
      if (entry.lost) return;
      entry.lost = true;
      try { onLost?.(name, error); }
      catch (recordError) {
        // The recorder itself failed: the other stream is the only place left to say so.
        const other = name === "stdout" ? streams.stderr : streams.stdout;
        try { other?.write?.(`[stdio] ${name} lost (${error?.code || error?.message || error}); recording it failed: ${recordError?.message || recordError}\n`); }
        catch (_writeError) { /* not an error: both streams are gone, nothing can carry the line */ }
      }
    });
  }
  return { state };
}

module.exports = { installStdioGuard };
