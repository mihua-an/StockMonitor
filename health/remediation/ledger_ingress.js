"use strict";

// The ledger's ingress: the one local pipe every other process hands its events in through
// (config/js/remediation_contract.js pipePath). Each connection's frames are decoded and admitted; a frame is
// acknowledged (a cumulative 8-byte count) only once it is settled -- refused, a duplicate, or written and fsync'd --
// so a Health that dies before its fsync leaves the event with the client to resend.

const net = require("net");
const contract = require("../../config/js/remediation_contract.js");

class RemediationIngress {
  /**
   * admit(event) -> { line } | { duplicate } | { refused } | { dropped }; refuse(reason, event);
   * durableLines() -> lines on disk. `stats` gains listening / clients_connected / last_error.
   */
  constructor({ pipePath, fs, logger, stats, admit, refuse, durableLines }) {
    Object.assign(this, { pipePath, fs, logger, stats, admit, refuse, durableLines });
    this.server = null;
    this.sockets = new Set();
    this.listeners = new Set();     // one per connection: acknowledges what became durable
  }

  /** Called by the writer after each fsync. */
  durable() {
    for (const advance of [...this.listeners]) advance();
  }

  listen() {
    return new Promise((resolve) => {
      if (process.platform !== "win32") {
        try { this.fs.unlinkSync(this.pipePath); }
        catch (error) {
          // absent is not an error: no stale pipe to remove
          if (error?.code !== "ENOENT") console.warn("[removing a stale remediation pipe] failed", error);
        }
      }
      const server = net.createServer((socket) => this.serve(socket));
      server.on("error", (error) => {
        this.stats.listening = false;
        this.stats.last_error = `pipe ${this.pipePath}: ${error.message}`;
        this.logger.error?.(`[REMEDIATION] ledger pipe unavailable (${error.message}); other processes' events are counted by them as lost`);
        resolve(false);
      });
      server.listen(this.pipePath, () => {
        this.server = server;
        this.stats.listening = true;
        resolve(true);
      });
    });
  }

  serve(socket) {
    this.sockets.add(socket);
    this.stats.clients_connected += 1;
    let frames = 0n, acked = 0n, overflow = false;
    const pending = [];   // [{ frame, line }]: accepted frames whose line is not yet written and fsync'd
    const decoder = contract.createFrameDecoder((event, error) => {
      frames += 1n;
      if (error) { this.refuse(error, null); return; }
      const admitted = this.admit(event);
      if (admitted.line) pending.push({ frame: frames, line: admitted.line });
      if (admitted.dropped) overflow = true;
    });
    // The cumulative count of frames this connection has handed over and that are settled: refused, duplicate, or
    // written and fsync'd. The client keeps everything beyond it and sends it again after a reconnect.
    const advance = () => {
      while (pending.length && pending[0].line <= this.durableLines()) pending.shift();
      const settled = pending.length ? pending[0].frame - 1n : frames;
      if (settled <= acked || socket.destroyed) return;
      acked = settled;
      const ack = Buffer.alloc(8);
      ack.writeBigUInt64LE(settled, 0);
      socket.write(ack);
    };
    this.listeners.add(advance);
    socket.on("data", (chunk) => {
      const ok = decoder.push(chunk);
      advance();
      // A full write queue: the frame was not taken, so the connection ends and the client resends after reconnecting.
      if (!ok || overflow) socket.destroy();
    });
    const gone = () => {
      this.listeners.delete(advance);
      this.sockets.delete(socket);
      this.stats.clients_connected = Math.max(0, this.stats.clients_connected - 1);
    };
    socket.once("close", gone);
    // not an error here: a connection error ends the connection, and "close" (above) is its record
    socket.on("error", () => {});
  }

  // server.close() resolves only once every client connection has ended, and Rust A/B and the daemons keep theirs
  // open: end them (whatever they had sent is already acknowledged or will be sent again to the next writer).
  async close() {
    if (this.server) {
      const closing = new Promise((resolve) => this.server.close(() => resolve()));
      for (const socket of this.sockets) socket.destroy();
      await closing;
    }
    this.server = null;
    this.stats.listening = false;
  }
}

module.exports = { RemediationIngress };
