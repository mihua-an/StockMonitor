//! Minimal RFC 6455 client for Market Runtime's loopback `/live` endpoint. std only, like the
//! daemon's own server half, whose frame reader it shares. Masks every client frame; answers Ping;
//! accepts text or binary messages carrying UTF-8 JSON (the daemon sends both).

use crate::timing::SOCKET_TIMEOUT;
use market_runtime::ws::{FrameReader, ReadLimits};
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Upper bound on one inbound frame. A `durable.subscribe` replay is a single batch frame and
/// the daemon does not page it, so this is deliberately large -- but bounded.
pub const MAX_FRAME_BYTES: u64 = 256 * 1024 * 1024;

/// The daemon's frames: unmasked, up to MAX_FRAME_BYTES, and a started frame may take two minutes to complete (a
/// large replay batch written while the daemon is busy).
const SERVER_FRAMES: ReadLimits = ReadLimits { peer_masks: false, max_bytes: MAX_FRAME_BYTES, body_timeout: Duration::from_secs(120) };

pub struct WsClient {
    stream: TcpStream,
    /// Reads the connection on a thread of its own with blocking reads; `recv` waits on it, never on a socket read
    /// timeout (a timed-out recv leaves a Windows socket indeterminate -- see market_runtime::ws::FrameReader).
    reader: FrameReader,
    rng: u64,
}

pub enum Incoming {
    Message(Vec<u8>),
    /// Nothing arrived within the idle timeout. Not an error.
    Idle,
}

fn seed() -> u64 {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    nanos ^ ((std::process::id() as u64) << 32) ^ 0x9e37_79b9_7f4a_7c15
}

use market_runtime::ws::base64;   // one encoder for A and B

/// `ws://host:port/path?query` -> (host, port, path_and_query). Loopback use only; no TLS.
pub fn parse_url(url: &str) -> io::Result<(String, u16, String)> {
    let rest = url
        .strip_prefix("ws://")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "only ws:// URLs are supported"))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "URL has no port"))?;
    let port = port.parse::<u16>().map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "bad port"))?;
    Ok((host.to_string(), port, path.to_string()))
}

impl WsClient {
    pub fn connect(url: &str, token: &str) -> io::Result<Self> {
        let (host, port, path) = parse_url(url)?;
        let address = (host.as_str(), port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no address"))?;
        let mut stream = TcpStream::connect_timeout(&address, SOCKET_TIMEOUT)?;
        stream.set_nodelay(true)?;
        stream.set_write_timeout(Some(SOCKET_TIMEOUT))?;
        stream.set_read_timeout(Some(SOCKET_TIMEOUT))?;
        let mut rng = seed();
        let mut key = [0u8; 16];
        for byte in key.iter_mut() {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            *byte = (rng >> 33) as u8;
        }
        // The credential goes in a header, never in the URL: Market Runtime does not read ?token=.
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
            base64(&key)
        );
        stream.write_all(request.as_bytes())?;
        let mut response = Vec::new();
        let mut byte = [0u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            if response.len() > 16 * 1024 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "handshake response too large"));
            }
            match stream.read(&mut byte)? {
                0 => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed during handshake")),
                _ => response.push(byte[0]),
            }
        }
        let status = String::from_utf8_lossy(&response);
        if !status.starts_with("HTTP/1.1 101") {
            let line = status.lines().next().unwrap_or_default().to_string();
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("upgrade refused: {line}")));
        }
        // The handshake read byte by byte up to the blank line, so nothing of the first frame was consumed.
        let reader = FrameReader::spawn(&stream, SERVER_FRAMES, "ws-client-reader")?;
        Ok(Self { stream, reader, rng })
    }

    fn next_mask(&mut self) -> [u8; 4] {
        self.rng = self.rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.rng >> 32) as u32).to_be_bytes()
    }

    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> io::Result<()> {
        let mut frame = Vec::with_capacity(payload.len() + 14);
        frame.push(0x80 | opcode);
        if payload.len() < 126 {
            frame.push(0x80 | payload.len() as u8);
        } else if payload.len() <= u16::MAX as usize {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        let mask = self.next_mask();
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        // One write, so a frame never reaches the daemon in more pieces than TCP makes of it.
        self.stream.write_all(&frame)?;
        self.stream.flush()
    }

    pub fn send_text(&mut self, text: &str) -> io::Result<()> {
        self.send_frame(1, text.as_bytes())
    }

    /// Next data message, answering pings on the way. `idle` bounds the wait for one so the caller
    /// can check its stop flag; zero only takes what has already arrived.
    pub fn recv(&mut self, idle: Duration) -> io::Result<Incoming> {
        loop {
            match self.reader.next(idle)? {
                None => return Ok(Incoming::Idle),
                Some((1 | 2, payload)) => return Ok(Incoming::Message(payload)),
                Some((8, _)) => return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "server closed")),
                Some((9, payload)) => self.send_frame(10, &payload)?,
                Some(_) => {}
            }
        }
    }

    pub fn close(mut self) {
        let _ = self.send_frame(8, &[]);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn url_parsing() {
        assert_eq!(super::parse_url("ws://127.0.0.1:8030/live").unwrap(), ("127.0.0.1".into(), 8030, "/live".into()));
        assert!(super::parse_url("wss://x:1/live").is_err());
        assert!(super::parse_url("ws://x/live").is_err());
    }

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(super::base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(super::base64(b"fo"), "Zm8=");
        assert_eq!(super::base64(b"f"), "Zg==");
    }
}
