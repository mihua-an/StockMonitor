//! Minimal RFC 6455 server transport for the market_runtime listener: an authenticated handshake that yields the
//! client's ROLE, bounded frames, and close frames with a reason the client can recognise (slow consumer,
//! shutdown, protocol error) instead of a silent drop.

use crate::contract::{Credentials, Role};
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

pub const MAX_FRAME_BYTES: u64 = 16 * 1024 * 1024;
pub const CLOSE_SLOW_CONSUMER: u16 = 4001;
pub const CLOSE_SHUTDOWN: u16 = 4002;
pub const CLOSE_PROTOCOL: u16 = 4003;
pub const CLOSE_FORBIDDEN: u16 = 4004;
/// The WAL recovery this connection waited through is over: connect again now, to the server that serves.
pub const CLOSE_RECOVERED: u16 = 4005;
/// Still recovering: only `health` is answered; a client sends nothing else until a health says it serves.
pub const CLOSE_RECOVERING: u16 = 4006;
/// Nothing arrived from this provider, not even a keepalive ping, for longer than its keepalive allows.
pub const CLOSE_PEER_SILENT: u16 = 4007;
/// RFC 6455 7.4.1: the peer broke the protocol (unmasked client frame, RSV bits, bad control frame, bad fragment).
pub const CLOSE_PROTOCOL_ERROR: u16 = 1002;
/// RFC 6455 7.4.1: a message too big to process.
pub const CLOSE_MESSAGE_TOO_BIG: u16 = 1009;

fn header_value<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().skip(1).find_map(|line| {
        line.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case(name)).map(|(_, v)| v.trim())
    })
}

/// Complete the upgrade and return the role proven by the `Authorization: Bearer` header. A credential in the URL
/// (`?token=`) or in `Sec-WebSocket-Protocol` is not read: the URL ends up in logs and diagnostics, and a
/// renderer page holds no credential at all -- Electron main adds the header to its handshake (ui/main/client_auth.js).
pub fn handshake(stream: &mut TcpStream, credentials: &Credentials) -> io::Result<Role> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    // Byte by byte up to the blank line, never past it: a client may send its first frame in the
    // same TCP segment as the upgrade request, and a block read would swallow those bytes with the request.
    let mut req = Vec::new();
    let mut byte = [0u8; 1];
    while !req.ends_with(b"\r\n\r\n") {
        let n = stream.read(&mut byte)?;
        if n == 0 || req.len() >= 16_384 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad handshake"));
        }
        req.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&req);
    let first = text.lines().next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    let presented = header_value(&text, "Authorization").and_then(|v| v.strip_prefix("Bearer ")).unwrap_or_default();
    let role = if method == "GET" && path == "/live" { credentials.authenticate(presented) } else { None };
    let Some(role) = role else {
        let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "invalid credential"));
    };
    let upgrade_ok = header_value(&text, "Upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let connection_ok = header_value(&text, "Connection").is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")));
    let version_ok = header_value(&text, "Sec-WebSocket-Version").is_some_and(|v| v == "13");
    let key = header_value(&text, "Sec-WebSocket-Key");
    let (true, true, true, Some(key)) = (upgrade_ok, connection_ok, version_ok, key) else {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
        return Err(io::Error::new(io::ErrorKind::InvalidData, "malformed websocket upgrade"));
    };
    let mut material = key.as_bytes().to_vec();
    material.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let accept = base64(&sha1(&material));
    write!(stream, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n")?;
    Ok(role)
}

/// Once a frame has started, the rest of a client frame may take this long to arrive.
pub const FRAME_BODY_TIMEOUT: Duration = Duration::from_secs(10);

/// What a `FrameReader` accepts from its peer.
#[derive(Clone, Copy, Debug)]
pub struct ReadLimits {
    /// The peer is a client: RFC 6455 requires its frames to be masked. A server's frames are accepted either way.
    pub peer_masks: bool,
    /// Bound on one message, reassembled fragments included.
    pub max_bytes: u64,
    /// How long the rest of a frame may take once its first byte has arrived.
    pub body_timeout: Duration,
}

/// The frames market_runtime's listener accepts from its clients.
pub const CLIENT_FRAMES: ReadLimits = ReadLimits { peer_masks: true, max_bytes: MAX_FRAME_BYTES, body_timeout: FRAME_BODY_TIMEOUT };

/// The peer broke RFC 6455; `code` is the close code to answer with (`answer_violation`).
#[derive(Debug)]
pub struct ProtocolViolation {
    pub code: u16,
    pub why: String,
}

impl std::fmt::Display for ProtocolViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.why)
    }
}

impl std::error::Error for ProtocolViolation {}

fn violation(code: u16, why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, ProtocolViolation { code, why: why.to_owned() })
}

fn violation_code(error: &io::Error) -> Option<u16> {
    error.get_ref().and_then(|inner| inner.downcast_ref::<ProtocolViolation>()).map(|v| v.code)
}

/// A frame read failed with a protocol violation: send the close code and reason, then half-close so they arrive
/// (the reader thread drains what the peer still sends, so closing with unread input does not RST them away).
/// The peer may already be gone; a close or half-close that cannot be sent is logged, the session ends either way.
pub fn answer_violation(stream: &mut TcpStream, error: &io::Error) {
    if close_for_violation(stream, error) {
        if let Err(e) = stream.shutdown(Shutdown::Write) {
            eprintln!("[ws] half-close after a protocol violation failed: {e}");
        }
    }
}

/// The close frame with the code and reason when `error` is a protocol violation (true). A connection written by a
/// `FrameWriter` is half-closed by `FrameReader::close_with` once the frame is out.
pub fn close_for_violation(out: &mut impl Write, error: &io::Error) -> bool {
    let Some(code) = violation_code(error) else {
        return false;
    };
    if let Err(e) = write_close(out, code, &error.to_string()) {
        eprintln!("[ws] close {code} after a protocol violation not sent: {e}");
    }
    true
}

type Frame = (u8, Vec<u8>);

/// Reads one connection's frames on a thread of its own, with blocking reads: a caller polls `next` with a timeout
/// instead of the socket. Polling the socket itself (a ~15 ms SO_RCVTIMEO on every serve-loop turn) is what broke
/// connections on Windows: a timed-out recv leaves the socket in an indeterminate state, and after hours of polling a
/// read or write failed with os error 997 (ERROR_IO_PENDING) and the connection was torn down -- B reconnected
/// and replayed. The thread never writes: pings are handed to the caller (which answers them), and a protocol
/// violation ends the reader with an error that `answer_violation` turns into the close frame.
///
/// RFC 6455: frames carry no RSV bits (no extension is negotiated), use a known opcode, and a control frame is
/// unfragmented with at most 125 bytes; a client's frames are masked. A fragmented data message is reassembled --
/// control frames between its fragments are handed on in order -- and returned whole, bounded by `max_bytes`.
pub struct FrameReader {
    rx: Option<mpsc::Receiver<io::Result<Frame>>>,
    socket: TcpStream,
    draining: Arc<AtomicBool>,
    /// `close_with` gave the shutdown to the writer: dropping does not cut off the frames it still has queued.
    handed_off: bool,
}

impl FrameReader {
    pub fn spawn(stream: &TcpStream, limits: ReadLimits, name: &str) -> io::Result<Self> {
        let socket = stream.try_clone()?;
        let mut reading = stream.try_clone()?;
        reading.set_read_timeout(None)?;
        // Bounded: a peer that sends faster than its frames are handled is held back by TCP, not buffered here.
        let (tx, rx) = mpsc::sync_channel(64);
        let draining = Arc::new(AtomicBool::new(false));
        let flag = draining.clone();
        thread::Builder::new().name(name.to_owned()).spawn(move || read_loop(&mut reading, limits, &tx, &flag))?;
        Ok(Self { rx: Some(rx), socket, draining, handed_off: false })
    }

    /// End a connection whose frames go through `writer`: the writer shuts the socket down after its last queued
    /// frame -- only the writing side when this reader is draining after a protocol violation, so the close frame
    /// arrives -- instead of this reader cutting off what is still queued. The writer's error, if it failed.
    pub fn close_with(mut self, writer: FrameWriter) -> io::Result<()> {
        let how = if self.draining.load(Ordering::Acquire) { Shutdown::Write } else { Shutdown::Both };
        self.handed_off = true;
        writer.finish(how)
    }

    /// The next message or control frame (ping 9, pong 10, close 8), or None when nothing arrived within `wait`.
    /// An error ends the connection.
    pub fn next(&self, wait: Duration) -> io::Result<Option<Frame>> {
        let rx = self.rx.as_ref().expect("receiver lives until drop");
        let received = if wait.is_zero() {
            rx.try_recv().map_err(|e| matches!(e, mpsc::TryRecvError::Disconnected))
        } else {
            rx.recv_timeout(wait).map_err(|e| matches!(e, mpsc::RecvTimeoutError::Disconnected))
        };
        match received {
            Ok(frame) => frame.map(Some),
            Err(false) => Ok(None),
            Err(true) => Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed")),
        }
    }
}

impl Drop for FrameReader {
    fn drop(&mut self) {
        // The thread is not joined. A reader blocked handing on a frame is released by the receiver going away; one
        // blocked in recv ends when the peer answers the shutdown's FIN by closing (or when Windows gives up on it,
        // 120 s): a shutdown does not wake a blocked recv on Windows, and waiting here would hold the session's
        // cleanup hostage to the peer. One draining after a violation ends on its own (bounded), so the close frame
        // is not cut short by a shutdown.
        drop(self.rx.take());
        if !self.handed_off && !self.draining.load(Ordering::Acquire) {
            let _ = self.socket.shutdown(Shutdown::Both);
        }
    }
}

fn read_loop(socket: &mut TcpStream, limits: ReadLimits, tx: &mpsc::SyncSender<io::Result<Frame>>, draining: &AtomicBool) {
    loop {
        let mut first = [0u8; 1];
        let result = match socket.read(&mut first) {
            Ok(0) => Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed")),
            Ok(_) => read_after_first(socket, first[0], limits, tx),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => Err(e),
        };
        match result {
            Ok(frame) => {
                let closed = frame.0 == 8;
                if tx.send(Ok(frame)).is_err() || closed {
                    return;
                }
            }
            Err(e) => {
                let violated = violation_code(&e).is_some();
                draining.store(violated, Ordering::Release);
                let _ = tx.send(Err(e));
                if violated {
                    drain(socket);
                }
                return;
            }
        }
    }
}

/// Read (and discard) what the peer still sends, bounded, while the close frame goes out.
fn drain(socket: &mut TcpStream) {
    let _ = socket.set_read_timeout(Some(Duration::from_millis(50)));
    let started = std::time::Instant::now();
    let mut sink = [0u8; 8192];
    let mut drained = 0usize;
    while started.elapsed() < Duration::from_millis(250) && drained < 1 << 20 {
        match socket.read(&mut sink) {
            Ok(0) | Err(_) => break,
            Ok(n) => drained += n,
        }
    }
}

/// The rest of a message after its first byte, under the body timeout. A timeout here cannot be resumed (part of
/// the frame is consumed) and is fatal.
fn read_after_first(socket: &mut TcpStream, first: u8, limits: ReadLimits, tx: &mpsc::SyncSender<io::Result<Frame>>) -> io::Result<Frame> {
    socket.set_read_timeout(Some(limits.body_timeout))?;
    let result = read_message_rest(socket, first, limits, &mut |control| tx.send(Ok(control)).is_ok()).map_err(|e| {
        if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) {
            io::Error::new(io::ErrorKind::InvalidData, format!("frame stalled mid-read: {e}"))
        } else {
            e
        }
    });
    socket.set_read_timeout(None)?;
    result
}

/// One message (or one control frame). `control` receives the control frames that arrive between the fragments of
/// a message; false from it (the caller is gone) ends the read.
fn read_message_rest(stream: &mut impl Read, first: u8, limits: ReadLimits, control: &mut dyn FnMut(Frame) -> bool) -> io::Result<Frame> {
    // A fragmented data message in progress: (opcode of its first frame, bytes so far).
    let mut message: Option<Frame> = None;
    let mut head = first;
    loop {
        let (fin, opcode, payload) = read_frame_rest(stream, head, limits)?;
        match opcode {
            8..=10 if message.is_none() => return Ok((opcode, payload)),
            8 => return Ok((8, payload)),
            9 | 10 => {
                if !control((opcode, payload)) {
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "frame reader closed"));
                }
            }
            0 => {
                let Some((_, buffer)) = message.as_mut() else {
                    return Err(violation(CLOSE_PROTOCOL_ERROR, "continuation frame without a message"));
                };
                if buffer.len() as u64 + payload.len() as u64 > limits.max_bytes {
                    return Err(violation(CLOSE_MESSAGE_TOO_BIG, "message too large"));
                }
                buffer.extend_from_slice(&payload);
                if fin {
                    return Ok(message.take().expect("message in progress"));
                }
            }
            _ => {
                // 1 or 2 (read_frame_rest refused every other opcode): a new data message.
                if message.is_some() {
                    return Err(violation(CLOSE_PROTOCOL_ERROR, "new message before the fragmented one ended"));
                }
                if fin {
                    return Ok((opcode, payload));
                }
                message = Some((opcode, payload));
            }
        }
        let mut next = [0u8; 1];
        stream.read_exact(&mut next)?;
        head = next[0];
    }
}

/// One frame after its first byte: (FIN, opcode, unmasked payload), validated against RFC 6455.
fn read_frame_rest(stream: &mut impl Read, first: u8, limits: ReadLimits) -> io::Result<(bool, u8, Vec<u8>)> {
    let mut second = [0u8; 1];
    stream.read_exact(&mut second)?;
    let fin = first & 0x80 != 0;
    let opcode = first & 0x0f;
    let masked = second[0] & 0x80 != 0;
    let mut len = (second[0] & 127) as u64;
    if first & 0x70 != 0 {
        return Err(violation(CLOSE_PROTOCOL_ERROR, "RSV bits set without a negotiated extension"));
    }
    if !matches!(opcode, 0 | 1 | 2 | 8 | 9 | 10) {
        return Err(violation(CLOSE_PROTOCOL_ERROR, "unknown opcode"));
    }
    if limits.peer_masks && !masked {
        return Err(violation(CLOSE_PROTOCOL_ERROR, "client frame is not masked"));
    }
    if opcode >= 8 && (!fin || len > 125) {
        return Err(violation(CLOSE_PROTOCOL_ERROR, "control frame fragmented or longer than 125 bytes"));
    }
    if opcode == 8 && len == 1 {
        return Err(violation(CLOSE_PROTOCOL_ERROR, "close frame with a one-byte payload"));
    }
    if len == 126 {
        let mut b = [0u8; 2];
        stream.read_exact(&mut b)?;
        len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
        let mut b = [0u8; 8];
        stream.read_exact(&mut b)?;
        len = u64::from_be_bytes(b);
    }
    if len > limits.max_bytes {
        return Err(violation(CLOSE_MESSAGE_TOO_BIG, "frame too large"));
    }
    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask)?;
    }
    let mut payload = vec![0u8; len as usize];
    stream.read_exact(&mut payload)?;
    if masked {
        for (i, v) in payload.iter_mut().enumerate() {
            *v ^= mask[i % 4];
        }
    }
    Ok((fin, opcode, payload))
}

pub fn write_frame(stream: &mut impl Write, opcode: u8, payload: &[u8]) -> io::Result<()> {
    let mut header = Vec::with_capacity(10);
    header.push(0x80 | opcode);
    if payload.len() < 126 {
        header.push(payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        header.push(126);
        header.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    stream.write_all(&header)?;
    stream.write_all(payload)?;
    stream.flush()
}

/// Longest close reason: a control frame carries at most 125 bytes, two of them the code.
const CLOSE_REASON_BYTES: usize = 123;

/// The close payload: the code, then as much of `reason` as fits whole -- cut on a character boundary, since the
/// reason must be valid UTF-8 (RFC 6455 section 5.5.1).
fn close_payload(code: u16, reason: &str) -> Vec<u8> {
    let mut end = reason.len().min(CLOSE_REASON_BYTES);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(&reason.as_bytes()[..end]);
    payload
}

pub fn write_close(stream: &mut impl Write, code: u16, reason: &str) -> io::Result<()> {
    write_frame(stream, 8, &close_payload(code, reason))
}

enum Outbound {
    Frame(Vec<u8>),
    /// Everything before it is written: shut the socket down this way and end.
    End(Shutdown),
}

/// Writes one connection's frames on a thread of its own, so the caller never waits on the socket: a peer that reads
/// slowly (B catching up a long replay does no reads between long stretches of work) holds back only this thread, and
/// what it has not taken yet waits here, in order, until it does. Nothing gives up on a slow peer: the connection ends
/// when the peer closes it or the socket fails. The caller bounds what waits by not producing more while `queued`
/// is high (the delivery loop's work then waits in its own bounded queue, or is read again from the WAL).
///
/// Each frame goes over as one hand-off: `write_frame` writes header and payload into the frame being built and
/// `flush` hands it on. A write error is kept and returned by every later `flush` and by `check`.
pub struct FrameWriter {
    tx: Option<mpsc::Sender<Outbound>>,
    queued: Arc<AtomicUsize>,
    state: Arc<WriterShared>,
    frame: Vec<u8>,
}

#[derive(Default)]
struct WriterState {
    error: Option<(io::ErrorKind, String)>,
    /// `finish` was called: no caller reads `error` any more, so the writer logs a failure itself.
    finished: bool,
    /// The writer thread returned (failed, shut the socket down, or lost its sender).
    ended: bool,
}

/// The writer's state and the signal it gives each time a frame is on the socket or it ends (`wait_written`).
#[derive(Default)]
struct WriterShared {
    state: Mutex<WriterState>,
    moved: Condvar,
}

impl WriterShared {
    fn lock(&self) -> std::sync::MutexGuard<'_, WriterState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl FrameWriter {
    pub fn spawn(stream: &TcpStream, name: &str) -> io::Result<Self> {
        let mut socket = stream.try_clone()?;
        let (tx, rx) = mpsc::channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let state = Arc::new(WriterShared::default());
        let (q, s) = (queued.clone(), state.clone());
        thread::Builder::new().name(name.to_owned()).spawn(move || {
            write_loop(&mut socket, &rx, &q, &s);
            s.lock().ended = true;
            s.moved.notify_all();
        })?;
        Ok(Self { tx: Some(tx), queued, state, frame: Vec::new() })
    }

    /// Bytes handed on and not yet taken by the socket.
    pub fn queued(&self) -> usize {
        self.queued.load(Ordering::Acquire)
    }

    /// The error that ended the writer, if it ended.
    pub fn check(&self) -> io::Result<()> {
        writer_error(&self.state.lock())
    }

    /// Blocks until every frame handed on so far is on the socket, or the writer failed or ended first (an error).
    /// For a frame that must be out before the caller acts -- the shutdown receipt, before the stop that tears the
    /// connections down is announced. The peer of such a frame is waiting for it; a slow one holds the caller.
    pub fn wait_written(&self) -> io::Result<()> {
        let mut state = self.state.lock();
        loop {
            writer_error(&state)?;
            if self.queued() == 0 {
                return Ok(());
            }
            if state.ended {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, format!("writer: ended with {} bytes unwritten", self.queued())));
            }
            state = self.state.moved.wait(state).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// No more frames: the writer writes what is queued, shuts the socket down `how`, and ends on its own (never
    /// waited for: a peer that stopped reading must not hold the caller). The writer's error, if it already failed.
    pub fn finish(mut self, how: Shutdown) -> io::Result<()> {
        let result = self.check();
        self.state.lock().finished = true;
        if let Some(tx) = self.tx.take() {
            // not an error: a writer that already ended has nothing left to shut down after; its error is `result`
            let _ = tx.send(Outbound::End(how));
        }
        result
    }
}

impl Write for FrameWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.frame.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.check()?;
        if self.frame.is_empty() {
            return Ok(());
        }
        let frame = std::mem::take(&mut self.frame);
        let n = frame.len();
        self.queued.fetch_add(n, Ordering::AcqRel);
        let sent = self.tx.as_ref().is_some_and(|tx| tx.send(Outbound::Frame(frame)).is_ok());
        if !sent {
            self.queued.fetch_sub(n, Ordering::AcqRel);
            self.check()?;
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "writer: ended"));
        }
        Ok(())
    }
}

impl Drop for FrameWriter {
    fn drop(&mut self) {
        if let Some(tx) = self.tx.take() {
            self.state.lock().finished = true;
            // not an error: a writer that already ended has closed the socket's writing side with its failure
            let _ = tx.send(Outbound::End(Shutdown::Both));
        }
    }
}

fn writer_error(state: &WriterState) -> io::Result<()> {
    match &state.error {
        Some((kind, message)) => Err(io::Error::new(*kind, format!("writer: {message}"))),
        None => Ok(()),
    }
}

fn write_loop(socket: &mut TcpStream, rx: &mpsc::Receiver<Outbound>, queued: &AtomicUsize, shared: &WriterShared) {
    while let Ok(message) = rx.recv() {
        match message {
            Outbound::Frame(bytes) => {
                if let Err(e) = socket.write_all(&bytes).and_then(|()| socket.flush()) {
                    let mut state = shared.lock();
                    if state.finished {
                        eprintln!("[ws] write after the session ended failed: kind={:?} os_error={:?}: {e}", e.kind(), e.raw_os_error());
                    }
                    state.error = Some((e.kind(), e.to_string()));
                    return;
                }
                queued.fetch_sub(bytes.len(), Ordering::AcqRel);
                // Taken under the lock so a `wait_written` that saw bytes queued is already waiting when notified.
                drop(shared.lock());
                shared.moved.notify_all();
            }
            Outbound::End(how) => {
                if let Err(e) = socket.shutdown(how) {
                    eprintln!("[ws] shutdown({how:?}) after the last frame failed: {e}");
                }
                return;
            }
        }
    }
}

const BASE64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding: the WebSocket handshake accept key and the replay timeline's change bytes.
pub fn base64(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = ((c[0] as u32) << 16) | ((c.get(1).copied().unwrap_or(0) as u32) << 8) | c.get(2).copied().unwrap_or(0) as u32;
        s.push(BASE64_ALPHABET[((n >> 18) & 63) as usize] as char);
        s.push(BASE64_ALPHABET[((n >> 12) & 63) as usize] as char);
        s.push(if c.len() > 1 { BASE64_ALPHABET[((n >> 6) & 63) as usize] as char } else { '=' });
        s.push(if c.len() > 2 { BASE64_ALPHABET[(n & 63) as usize] as char } else { '=' });
    }
    s
}

pub fn unbase64(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let digit = |c: u8| -> Result<u32, String> {
        BASE64_ALPHABET.iter().position(|d| *d == c).map(|p| p as u32).ok_or_else(|| format!("not base64: {}", c as char))
    };
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err("base64 length is not a multiple of 4".into());
    }
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().rev().take_while(|c| **c == b'=').count();
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= if *c == b'=' { 0 } else { digit(*c)? } << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut msg = data.to_vec();
    let bits = (msg.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    let (mut h0, mut h1, mut h2, mut h3, mut h4) = (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32, 0xc3d2e1f0u32);
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5a827999),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, v) in [h0, h1, h2, h3, h4].iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_close_reason_is_cut_on_a_character_boundary_within_the_control_frame() {
        let reason = "行情".repeat(30);   // 180 bytes, 3 per character
        let payload = close_payload(1002, &reason);
        assert!(payload.len() <= 125);
        assert_eq!(&payload[..2], &1002u16.to_be_bytes());
        let text = std::str::from_utf8(&payload[2..]).expect("valid UTF-8");
        assert_eq!(text.len(), 123, "41 whole characters");
        assert!(reason.starts_with(text));
        assert_eq!(close_payload(1000, "bye"), [&1000u16.to_be_bytes()[..], b"bye"].concat());
    }

    #[test]
    fn websocket_accept_key_matches_rfc6455_example() {
        let mut material = b"dGhlIHNhbXBsZSBub25jZQ==".to_vec();
        material.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
        assert_eq!(base64(&sha1(&material)), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    // --- The handshake keeps the bytes after it; client frames follow RFC 6455. ---

    use std::net::TcpListener;
    use std::thread;

    const TOKEN: &str = "viewer-token-0123456789";

    fn upgrade_request() -> Vec<u8> {
        format!("GET /live HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
                 Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").into_bytes()
    }

    /// A client frame: `first` is the FIN/RSV/opcode byte, `masked` whether the mask bit and key are sent.
    fn frame(first: u8, payload: &[u8], masked: bool) -> Vec<u8> {
        let mut out = vec![first];
        let bit = if masked { 0x80 } else { 0 };
        if payload.len() < 126 {
            out.push(bit | payload.len() as u8);
        } else {
            out.push(bit | 126);
            out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        if masked {
            let mask = [3u8, 1, 4, 1];
            out.extend_from_slice(&mask);
            out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        } else {
            out.extend_from_slice(payload);
        }
        out
    }

    /// Serve one connection the way the listener does: handshake, then read messages through a FrameReader until an
    /// error or close, answering pings and violations; returns what was read and what the client received.
    fn serve(client_bytes: Vec<u8>) -> (Vec<io::Result<(u8, Vec<u8>)>>, Vec<u8>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let creds = Credentials::for_tests(&[("viewer", TOKEN)]);
            handshake(&mut stream, &creds).unwrap();
            let reader = FrameReader::spawn(&stream, CLIENT_FRAMES, "test-reader").unwrap();
            let mut read = Vec::new();
            loop {
                let result = match reader.next(Duration::from_millis(300)) {
                    Ok(Some(frame)) => Ok(frame),
                    Ok(None) => Err(io::Error::new(io::ErrorKind::TimedOut, "idle")),
                    Err(e) => Err(e),
                };
                match &result {
                    Ok((9, p)) => write_frame(&mut stream, 10, p).unwrap(),
                    Err(e) => answer_violation(&mut stream, e),
                    _ => {}
                }
                let stop = !matches!(result, Ok((1 | 2 | 9 | 10, _)));
                read.push(result);
                if stop {
                    break;
                }
            }
            drop(reader);
            read
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        // Everything in ONE write: the upgrade request and the frames after it share a segment.
        let mut bytes = upgrade_request();
        bytes.extend_from_slice(&client_bytes);
        client.write_all(&bytes).unwrap();
        let read = server.join().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        let mut received = Vec::new();
        let mut buf = [0u8; 4096];
        while let Ok(n) = client.read(&mut buf) {
            if n == 0 {
                break;
            }
            received.extend_from_slice(&buf[..n]);
        }
        (read, received)
    }

    fn close_code(received: &[u8]) -> Option<u16> {
        let body = &received[received.windows(4).position(|w| w == b"\r\n\r\n")? + 4..];
        let mut at = 0;
        while at + 2 <= body.len() {
            let opcode = body[at] & 0x0f;
            let len = (body[at + 1] & 127) as usize;
            if opcode == 8 && len >= 2 {
                return Some(u16::from_be_bytes([body[at + 2], body[at + 3]]));
            }
            at += 2 + len;
        }
        None
    }

    #[test]
    fn a_first_frame_in_the_same_segment_as_the_upgrade_is_not_lost() {
        let (read, _) = serve(frame(0x81, br#"{"type":"health"}"#, true));
        assert_eq!(read[0].as_ref().unwrap(), &(1u8, br#"{"type":"health"}"#.to_vec()));
    }

    #[test]
    fn protocol_violations_close_with_1002() {
        for (name, bytes) in [
            ("unmasked", frame(0x81, b"{}", false)),
            ("rsv1", frame(0xC1, b"{}", true)),
            ("rsv3", frame(0x91, b"{}", true)),
            ("unknown opcode", frame(0x83, b"{}", true)),
            ("fragmented ping", frame(0x09, b"p", true)),
            ("long ping", frame(0x89, &[0u8; 126], true)),
            ("one-byte close", frame(0x88, b"x", true)),
            ("continuation first", frame(0x80, b"x", true)),
            ("new message inside a fragmented one", [frame(0x01, b"a", true), frame(0x81, b"b", true)].concat()),
        ] {
            let (read, received) = serve(bytes);
            let last = read.last().unwrap();
            assert!(matches!(last, Err(e) if e.kind() == io::ErrorKind::InvalidData), "{name}: {last:?}");
            assert_eq!(close_code(&received), Some(CLOSE_PROTOCOL_ERROR), "{name}");
        }
    }

    #[test]
    fn a_fragmented_message_is_reassembled_and_pings_between_fragments_are_answered() {
        let bytes = [
            frame(0x01, br#"{"type":"#, true),          // text, FIN=0
            frame(0x89, b"hi", true),                   // ping between fragments
            frame(0x00, br#""health"#, true),           // continuation, FIN=0
            frame(0x80, br#""}"#, true),                // continuation, FIN=1
            frame(0x82, b"\x01\x02", true),             // a following binary message, unfragmented
            frame(0x88, &1000u16.to_be_bytes(), true),  // close
        ]
        .concat();
        let (read, received) = serve(bytes);
        // The ping is handed on as it arrives, before the message it interrupted is complete.
        assert_eq!(read[0].as_ref().unwrap(), &(9u8, b"hi".to_vec()));
        assert_eq!(read[1].as_ref().unwrap(), &(1u8, br#"{"type":"health"}"#.to_vec()));
        assert_eq!(read[2].as_ref().unwrap(), &(2u8, vec![1u8, 2]));
        assert_eq!(read[3].as_ref().unwrap().0, 8);
        let body = &received[received.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4..];
        assert_eq!(&body[..4], &[0x8A, 2, b'h', b'i'], "the ping was answered with a pong carrying its payload");
    }

    /// A connected pair: the accepted end and the client end.
    fn tcp_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        (listener.accept().unwrap().0, client)
    }

    #[test]
    fn a_frame_waited_for_is_on_the_socket_before_the_socket_is_shut_down() {
        // The shutdown receipt: queued behind other frames, then the stop shuts every client socket down. A socket
        // shut down while the frame still waits in the writer never carries it (os error 10058 in the writer, EOF at
        // the peer).
        let (server, mut client) = tcp_pair();
        // The peer reads all along, as the requester waiting for its receipt does.
        let reading = thread::spawn(move || {
            let mut received = Vec::new();
            client.read_to_end(&mut received).map(|_| received)
        });
        let mut out = FrameWriter::spawn(&server, "test-writer").unwrap();
        for _ in 0..200 {
            write_frame(&mut out, 1, &[b'x'; 1000]).unwrap();
        }
        write_frame(&mut out, 1, b"receipt").unwrap();
        out.wait_written().unwrap();
        assert_eq!(out.queued(), 0);
        server.shutdown(Shutdown::Both).unwrap();
        let received = reading.join().unwrap().unwrap();
        assert!(received.ends_with(&[0x81, 7, b'r', b'e', b'c', b'e', b'i', b'p', b't']), "{} bytes, last {:?}", received.len(), &received[received.len().saturating_sub(9)..]);
    }

    #[test]
    fn waiting_on_a_writer_that_cannot_write_is_its_error_not_a_hang() {
        let (server, _client) = tcp_pair();
        server.shutdown(Shutdown::Write).unwrap();
        let mut out = FrameWriter::spawn(&server, "test-writer").unwrap();
        write_frame(&mut out, 1, b"receipt").unwrap();
        let error = out.wait_written().unwrap_err();
        assert!(error.to_string().starts_with("writer: "), "{error}");
    }

    #[test]
    fn a_frame_that_stalls_after_its_first_byte_is_fatal_not_an_idle_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            handshake(&mut stream, &Credentials::for_tests(&[("viewer", TOKEN)])).unwrap();
            let limits = ReadLimits { body_timeout: Duration::from_millis(300), ..CLIENT_FRAMES };
            let reader = FrameReader::spawn(&stream, limits, "test-reader").unwrap();
            // Idle: nothing started, so the poll comes back empty and the caller simply polls again.
            assert!(reader.next(Duration::from_millis(15)).unwrap().is_none());
            reader.next(Duration::from_secs(5))
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client.write_all(&upgrade_request()).unwrap();
        thread::sleep(Duration::from_millis(100));
        // Header and mask of a 100-byte text frame, then nothing more.
        client.write_all(&[0x81, 0x80 | 100, 1, 2, 3, 4]).unwrap();
        let result = server.join().unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{error:?}");
        assert!(error.to_string().starts_with("frame stalled mid-read"), "{error}");
        drop(client);
    }

    #[test]
    fn an_idle_connection_polled_for_a_long_time_still_reads_and_writes() {
        // The serve loop polls every ~15 ms. Polling the socket's own read timeout that often eventually failed a
        // read or write with os error 997 on Windows; the reader thread's blocking read is never timed out.
        // The client writes only after the server has counted IDLE_POLLS empty polls, so the poll count never
        // depends on how finely the OS timer can sleep (Windows rounds a 1 ms wait up to ~15.6 ms).
        const IDLE_POLLS: u32 = 150;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (idle_done, idle_done_rx) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            handshake(&mut stream, &Credentials::for_tests(&[("viewer", TOKEN)])).unwrap();
            let reader = FrameReader::spawn(&stream, CLIENT_FRAMES, "test-reader").unwrap();
            let mut polls = 0;
            loop {
                match reader.next(Duration::from_millis(1)).unwrap() {
                    None => {
                        polls += 1;
                        write_frame(&mut stream, 1, b"tick").unwrap();
                        if polls == IDLE_POLLS {
                            idle_done.send(()).unwrap();
                        }
                    }
                    Some(frame) => return (polls, frame),
                }
            }
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client.write_all(&upgrade_request()).unwrap();
        idle_done_rx.recv_timeout(Duration::from_secs(30)).expect("server never finished its idle polls");
        client.write_all(&frame(0x81, b"{}", true)).unwrap();
        let (polls, frame) = server.join().unwrap();
        assert!(polls >= IDLE_POLLS, "{polls}");
        assert_eq!(frame, (1u8, b"{}".to_vec()));
    }

    #[test]
    fn a_reassembled_message_is_bounded() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            handshake(&mut stream, &Credentials::for_tests(&[("viewer", TOKEN)])).unwrap();
            let reader = FrameReader::spawn(&stream, CLIENT_FRAMES, "test-reader").unwrap();
            let result = reader.next(Duration::from_secs(30));
            if let Err(e) = &result {
                answer_violation(&mut stream, e);
            }
            result
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client.write_all(&upgrade_request()).unwrap();
        // A first fragment that announces MAX_FRAME_BYTES, then a continuation that crosses the limit.
        let mut first = vec![0x01u8, 0x80 | 127];
        first.extend_from_slice(&MAX_FRAME_BYTES.to_be_bytes());
        first.extend_from_slice(&[0, 0, 0, 0]);
        client.write_all(&first).unwrap();
        let chunk = vec![0u8; 1 << 20];
        for _ in 0..16 {
            client.write_all(&chunk).unwrap();
        }
        client.write_all(&frame(0x80, b"x", true)).unwrap();
        let result = server.join().unwrap();
        assert!(matches!(result, Err(e) if e.to_string() == "message too large"));
    }
}
