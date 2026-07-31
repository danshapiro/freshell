use std::fmt;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const READ_CHUNK_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug)]
pub(crate) struct HttpLimits {
    pub connect_timeout: Duration,
    pub total_timeout: Duration,
    pub max_header_bytes: usize,
    pub max_body_bytes: usize,
}

impl Default for HttpLimits {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(2),
            total_timeout: Duration::from_secs(5),
            max_header_bytes: 64 * 1024,
            max_body_bytes: 16 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct HttpError(String);

impl fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for HttpError {}

pub(crate) fn get(
    address: SocketAddr,
    host: &str,
    path: &str,
    auth_token: Option<&str>,
    limits: HttpLimits,
) -> Result<HttpResponse, HttpError> {
    if limits.connect_timeout.is_zero()
        || limits.total_timeout.is_zero()
        || limits.max_header_bytes == 0
    {
        return Err(HttpError("HTTP limits must be positive".to_string()));
    }
    if path.bytes().any(|byte| byte == b'\r' || byte == b'\n')
        || host.bytes().any(|byte| byte == b'\r' || byte == b'\n')
        || auth_token.is_some_and(|token| token.bytes().any(|byte| byte == b'\r' || byte == b'\n'))
    {
        return Err(HttpError(
            "HTTP request fields must not contain newlines".to_string(),
        ));
    }

    let started = Instant::now();
    let deadline = started
        .checked_add(limits.total_timeout)
        .ok_or_else(|| HttpError("HTTP total deadline is invalid".to_string()))?;
    let connect_timeout = limits
        .connect_timeout
        .min(remaining(deadline, "HTTP connect deadline elapsed")?);
    let mut stream = TcpStream::connect_timeout(&address, connect_timeout)
        .map_err(|error| HttpError(format!("HTTP connect failed before deadline: {error}")))?;

    let auth = auth_token
        .map(|token| format!("x-auth-token: {token}\r\n"))
        .unwrap_or_default();
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{auth}Connection: close\r\n\r\n");
    write_before_deadline(&mut stream, request.as_bytes(), deadline)?;
    read_response(&mut stream, deadline, limits)
}

fn write_before_deadline(
    stream: &mut TcpStream,
    mut bytes: &[u8],
    deadline: Instant,
) -> Result<(), HttpError> {
    while !bytes.is_empty() {
        stream
            .set_write_timeout(Some(remaining(
                deadline,
                "HTTP total deadline elapsed while writing request",
            )?))
            .map_err(|error| HttpError(format!("cannot set HTTP write deadline: {error}")))?;
        match stream.write(bytes) {
            Ok(0) => {
                return Err(HttpError(
                    "HTTP connection closed while writing request".to_string(),
                ))
            }
            Ok(written) => bytes = &bytes[written..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                return Err(HttpError(
                    "HTTP total deadline elapsed while writing request".to_string(),
                ))
            }
            Err(error) => return Err(HttpError(format!("HTTP request write failed: {error}"))),
        }
    }
    Ok(())
}

fn read_response(
    stream: &mut TcpStream,
    deadline: Instant,
    limits: HttpLimits,
) -> Result<HttpResponse, HttpError> {
    let mut bytes = Vec::new();
    let mut header_end = None;
    let mut expected_body_bytes = None;
    loop {
        if let Some(end) = header_end {
            let body_bytes = bytes.len() - end;
            if body_bytes > limits.max_body_bytes {
                return Err(HttpError(format!(
                    "HTTP response body exceeds {} bytes",
                    limits.max_body_bytes
                )));
            }
            if expected_body_bytes.is_some_and(|expected| body_bytes == expected) {
                return parse_complete_response(bytes, end);
            }
            if expected_body_bytes.is_some_and(|expected| body_bytes > expected) {
                return Err(HttpError(
                    "HTTP response contains bytes beyond Content-Length".to_string(),
                ));
            }
        }

        stream
            .set_read_timeout(Some(remaining(
                deadline,
                "HTTP total deadline elapsed while reading response",
            )?))
            .map_err(|error| HttpError(format!("cannot set HTTP read deadline: {error}")))?;
        let mut chunk = [0_u8; READ_CHUNK_BYTES];
        let body_remaining = header_end
            .map(|end| limits.max_body_bytes.saturating_sub(bytes.len() - end))
            .unwrap_or(limits.max_header_bytes.saturating_sub(bytes.len()));
        let read_limit = body_remaining.saturating_add(1).min(chunk.len());
        match stream.read(&mut chunk[..read_limit]) {
            Ok(0) => {
                let end = header_end.ok_or_else(|| {
                    HttpError("HTTP response closed before complete headers".to_string())
                })?;
                if let Some(expected) = expected_body_bytes {
                    let actual = bytes.len() - end;
                    if actual != expected {
                        return Err(HttpError(format!(
                            "HTTP response body ended at {actual} bytes; expected {expected}"
                        )));
                    }
                }
                return parse_complete_response(bytes, end);
            }
            Ok(read) => {
                bytes.extend_from_slice(&chunk[..read]);
                if header_end.is_none() {
                    if let Some(split) = find_header_end(&bytes) {
                        if split > limits.max_header_bytes {
                            return Err(HttpError(format!(
                                "HTTP response headers exceed {} bytes",
                                limits.max_header_bytes
                            )));
                        }
                        let body_start = split + 4;
                        expected_body_bytes =
                            parse_content_length(&bytes[..split], limits.max_body_bytes)?;
                        header_end = Some(body_start);
                        if bytes.len() - body_start > limits.max_body_bytes {
                            return Err(HttpError(format!(
                                "HTTP response body exceeds {} bytes",
                                limits.max_body_bytes
                            )));
                        }
                    } else if bytes.len() > limits.max_header_bytes {
                        return Err(HttpError(format!(
                            "HTTP response headers exceed {} bytes",
                            limits.max_header_bytes
                        )));
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                return Err(HttpError(
                    "HTTP total deadline elapsed while reading response".to_string(),
                ))
            }
            Err(error) => return Err(HttpError(format!("HTTP response read failed: {error}"))),
        }
    }
}

fn remaining(deadline: Instant, message: &str) -> Result<Duration, HttpError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| HttpError(message.to_string()))
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(headers: &[u8], max_body_bytes: usize) -> Result<Option<usize>, HttpError> {
    let headers = std::str::from_utf8(headers)
        .map_err(|_| HttpError("HTTP response headers are not UTF-8".to_string()))?;
    let mut content_length = None;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            return Err(HttpError("HTTP response header is malformed".to_string()));
        };
        if name.eq_ignore_ascii_case("transfer-encoding") && !value.trim().is_empty() {
            return Err(HttpError(
                "HTTP transfer encoding is not supported".to_string(),
            ));
        }
        if name.eq_ignore_ascii_case("content-length") {
            let parsed = value
                .trim()
                .parse::<usize>()
                .map_err(|_| HttpError("HTTP Content-Length is malformed".to_string()))?;
            if content_length
                .replace(parsed)
                .is_some_and(|old| old != parsed)
            {
                return Err(HttpError(
                    "HTTP response has conflicting Content-Length headers".to_string(),
                ));
            }
        }
    }
    if content_length.is_some_and(|length| length > max_body_bytes) {
        return Err(HttpError(format!(
            "HTTP response body exceeds {max_body_bytes} bytes"
        )));
    }
    Ok(content_length)
}

fn parse_complete_response(bytes: Vec<u8>, body_start: usize) -> Result<HttpResponse, HttpError> {
    let headers = std::str::from_utf8(&bytes[..body_start - 4])
        .map_err(|_| HttpError("HTTP response headers are not UTF-8".to_string()))?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| {
            let mut fields = line.split_whitespace();
            let version = fields.next()?;
            let status = fields.next()?.parse::<u16>().ok()?;
            matches!(version, "HTTP/1.0" | "HTTP/1.1").then_some(status)
        })
        .ok_or_else(|| HttpError("HTTP response status is malformed".to_string()))?;
    Ok(HttpResponse {
        status,
        body: bytes[body_start..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::{SocketAddr, TcpListener};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::{get, HttpLimits};

    fn listener() -> (TcpListener, SocketAddr) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        (listener, address)
    }

    fn limits(total_timeout: Duration, max_body_bytes: usize) -> HttpLimits {
        HttpLimits {
            connect_timeout: Duration::from_millis(100),
            total_timeout,
            max_header_bytes: 1024,
            max_body_bytes,
        }
    }

    #[test]
    fn complete_content_length_response_does_not_wait_for_close() {
        let (listener, address) = listener();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello")
                .unwrap();
            thread::sleep(Duration::from_millis(500));
        });

        let started = Instant::now();
        let response = get(
            address,
            "localhost",
            "/",
            None,
            limits(Duration::from_millis(200), 16),
        )
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"hello");
        assert!(started.elapsed() < Duration::from_millis(400));
        server.join().unwrap();
    }

    #[test]
    fn trickling_response_cannot_extend_total_deadline() {
        let (listener, address) = listener();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n");
            for _ in 0..30 {
                thread::sleep(Duration::from_millis(20));
                if stream.write_all(b"x").is_err() {
                    break;
                }
            }
        });

        let started = Instant::now();
        let error = get(
            address,
            "localhost",
            "/",
            None,
            limits(Duration::from_millis(120), 128),
        )
        .unwrap_err();

        assert!(error.to_string().contains("deadline"));
        assert!(started.elapsed() < Duration::from_millis(400));
        server.join().unwrap();
    }

    #[test]
    fn oversized_response_is_rejected_before_reading_the_body() {
        let (listener, address) = listener();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 17\r\n\r\n")
                .unwrap();
            thread::sleep(Duration::from_millis(200));
        });

        let error = get(
            address,
            "localhost",
            "/",
            None,
            limits(Duration::from_millis(100), 16),
        )
        .unwrap_err();

        assert!(error.to_string().contains("body exceeds"));
        server.join().unwrap();
    }

    #[test]
    fn accepted_connection_that_never_replies_hits_total_deadline() {
        let (listener, address) = listener();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(300));
        });

        let started = Instant::now();
        let error = get(
            address,
            "localhost",
            "/",
            None,
            limits(Duration::from_millis(100), 16),
        )
        .unwrap_err();

        assert!(error.to_string().contains("deadline"));
        assert!(started.elapsed() < Duration::from_millis(300));
        server.join().unwrap();
    }
}
