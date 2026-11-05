//! Discover the endpoint announced by the exact spawned child's stderr.
//! Both sidecar callers share one bounded collector and one startup deadline.
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::oneshot;

pub const REQUESTED_LISTEN_URL: &str = "ws://127.0.0.1:0";
const STDERR_SAMPLE_MAX_BYTES: usize = 4096;
const ANNOUNCEMENT_LINE_MAX_BYTES: usize = 512;

pub struct StartupOutput {
    sample: Arc<Mutex<Vec<u8>>>,
    endpoint: oneshot::Receiver<String>,
    drained: oneshot::Receiver<()>,
}

impl StartupOutput {
    /// The caller supplies its existing absolute deadline; discovery never
    /// starts another readiness budget or accepts a guessed listener.
    pub async fn wait_for_endpoint(
        &mut self,
        deadline: tokio::time::Instant,
    ) -> Result<String, &'static str> {
        match tokio::time::timeout_at(deadline, &mut self.endpoint).await {
            Ok(Ok(endpoint)) => Ok(endpoint),
            Ok(Err(_)) => Err("app-server stderr closed before its endpoint announcement"),
            Err(_) => Err("app-server endpoint announcement timed out"),
        }
    }

    /// Keep the existing failure diagnostic bounded even if a wrapper leaves
    /// another writer holding its stderr pipe after the child exits.
    pub async fn stderr_tail_after_exit(self) -> Vec<u8> {
        let mut drained = self.drained;
        let _ = tokio::time::timeout(Duration::from_millis(100), &mut drained).await;
        self.sample
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

pub fn drain_child_output(child: &mut tokio::process::Child) -> StartupOutput {
    if let Some(mut stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
        });
    }
    match child.stderr.take() {
        Some(stderr) => capture_stderr(stderr),
        None => capture_stderr(tokio::io::empty()),
    }
}

fn capture_stderr(mut stderr: impl AsyncRead + Unpin + Send + 'static) -> StartupOutput {
    let sample = Arc::new(Mutex::new(Vec::with_capacity(STDERR_SAMPLE_MAX_BYTES)));
    let sample_for_task = Arc::clone(&sample);
    let (endpoint_tx, endpoint) = oneshot::channel();
    let (drained_tx, drained) = oneshot::channel();
    tokio::spawn(async move {
        let mut endpoint_tx = Some(endpoint_tx);
        let mut line = Vec::with_capacity(ANNOUNCEMENT_LINE_MAX_BYTES);
        let mut overlong = false;
        let mut chunk = [0_u8; 1024];
        loop {
            let count = match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            {
                let mut tail = sample_for_task
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let overflow = tail
                    .len()
                    .saturating_add(count)
                    .saturating_sub(STDERR_SAMPLE_MAX_BYTES);
                if overflow > 0 {
                    let drain_len = overflow.min(tail.len());
                    tail.drain(..drain_len);
                }
                tail.extend_from_slice(&chunk[..count]);
            }
            if endpoint_tx.is_none() {
                continue;
            }
            for byte in &chunk[..count] {
                if *byte == b'\n' {
                    if !overlong {
                        if let Some(endpoint) = parse_announcement(&line) {
                            if let Some(sender) = endpoint_tx.take() {
                                let _ = sender.send(endpoint);
                            }
                            break;
                        }
                    }
                    line.clear();
                    overlong = false;
                } else if !overlong {
                    if line.len() < ANNOUNCEMENT_LINE_MAX_BYTES {
                        line.push(*byte);
                    } else {
                        line.clear();
                        overlong = true;
                    }
                }
            }
        }
        drop(endpoint_tx);
        let _ = drained_tx.send(());
    });
    StartupOutput {
        sample,
        endpoint,
        drained,
    }
}

fn parse_announcement(line: &[u8]) -> Option<String> {
    // Native banners normally disable colors on a pipe. Honor explicit color
    // overrides too, without retaining an unbounded escape sequence or line.
    let mut clean = Vec::with_capacity(line.len());
    let mut index = 0;
    while index < line.len() {
        if line[index] == 0x1b {
            if line.get(index + 1) != Some(&b'[') {
                return None;
            }
            index += 2;
            let start = index;
            while index < line.len() && !(0x40..=0x7e).contains(&line[index]) {
                if index - start >= 32 {
                    return None;
                }
                index += 1;
            }
            if index == line.len() {
                return None;
            }
            index += 1;
        } else {
            clean.push(line[index]);
            index += 1;
        }
    }
    let text = std::str::from_utf8(&clean).ok()?.trim();
    let addr: SocketAddr = text.strip_prefix("listening on: ws://")?.parse().ok()?;
    if addr.ip() != Ipv4Addr::LOCALHOST || addr.port() == 0 {
        return None;
    }
    Some(format!("ws://{addr}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn collector_accepts_a_native_banner_at_every_read_boundary() {
        let banner = b"native noise\n  listening on: ws://127.0.0.1:43219\r\n";
        for boundary in 0..banner.len() {
            let (mut writer, reader) = tokio::io::duplex(16);
            let mut output = capture_stderr(reader);
            let left = banner[..boundary].to_vec();
            let right = banner[boundary..].to_vec();
            tokio::spawn(async move {
                writer.write_all(&left).await.unwrap();
                tokio::task::yield_now().await;
                writer.write_all(&right).await.unwrap();
            });
            assert_eq!(
                output
                    .wait_for_endpoint(tokio::time::Instant::now() + Duration::from_secs(2))
                    .await
                    .unwrap(),
                "ws://127.0.0.1:43219"
            );
        }
    }

    #[tokio::test]
    async fn collector_ignores_invalid_and_overlong_lines_and_bounds_its_tail() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        let mut output = capture_stderr(reader);
        tokio::spawn(async move {
            writer.write_all(&vec![b'x'; 64 * 1024]).await.unwrap();
            writer.write_all(b"listening on: ws://127.0.0.1:9\nlistening on: ws://0.0.0.0:9\nlistening on: ws://127.0.0.1:0\nlistening on: ws://127.0.0.1:9/path\n").await.unwrap();
            writer
                .write_all(b"  \x1b[2mlistening on:\x1b[0m \x1b[32mws://127.0.0.1:43219\x1b[0m\n")
                .await
                .unwrap();
        });
        assert_eq!(
            output
                .wait_for_endpoint(tokio::time::Instant::now() + Duration::from_secs(2))
                .await
                .unwrap(),
            "ws://127.0.0.1:43219"
        );
        assert!(output.stderr_tail_after_exit().await.len() <= STDERR_SAMPLE_MAX_BYTES);
    }

    #[tokio::test]
    async fn collector_settles_missing_announcement_on_eof_or_original_deadline() {
        let mut closed = capture_stderr(tokio::io::empty());
        assert!(closed
            .wait_for_endpoint(tokio::time::Instant::now() + Duration::from_secs(2))
            .await
            .unwrap_err()
            .contains("closed"));
        let (_writer, reader) = tokio::io::duplex(16);
        let mut stalled = capture_stderr(reader);
        assert!(stalled
            .wait_for_endpoint(tokio::time::Instant::now() + Duration::from_millis(20))
            .await
            .unwrap_err()
            .contains("timed out"));
    }
}
