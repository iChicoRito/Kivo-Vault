use std::fs;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use reqwest::blocking::Client;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect::Policy;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// Public site icons, but the file names are hashed so the cache never holds a
/// readable list of the sites saved in the vault.
const ICON_DIR: &str = "icons";
const MAX_ICON_BYTES: usize = 512 * 1024;
const TIMEOUT_SECONDS: u64 = 5;
const USER_AGENT: &str = "Kivo";

fn cache_name(host: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(host.as_bytes());

    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join(ICON_DIR);

    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    Ok(dir)
}

/// Plain client for tests against a local HTTP server.
#[cfg(test)]
fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECONDS))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| error.to_string())
}

/// True for addresses on the open internet. Loopback, private, link-local,
/// shared (CGNAT), multicast and unspecified addresses are refused so a saved
/// site can never make Kivo talk to the user's own machine or network.
pub(crate) fn is_public(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        other => other,
    };

    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b)))
        }
        IpAddr::V6(v6) => {
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unique_local()
                || v6.is_unicast_link_local())
        }
    }
}

fn is_ip_literal(host: &str) -> bool {
    host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok()
}

/// Keeps only public addresses, so a name with mixed public and private
/// answers can only ever connect to the public ones.
pub(crate) fn public_addrs(addrs: impl Iterator<Item = SocketAddr>) -> Vec<SocketAddr> {
    addrs.filter(|addr| is_public(addr.ip())).collect()
}

/// Resolves names like the system does, then drops every non-public address.
/// Every request goes through it, including redirects and icon links on other
/// hosts, so a name that points at 127.0.0.1 is refused at connect time.
pub(crate) struct PublicResolver;

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();

        // ponytail: blocking lookup on reqwest's own runtime thread; each icon
        // fetch builds its own client, so only that fetch waits.
        Box::pin(async move {
            let addrs = public_addrs((host.as_str(), 0).to_socket_addrs()?);

            if addrs.is_empty() {
                return Err("The site has no public address".into());
            }

            Ok::<Addrs, Box<dyn std::error::Error + Send + Sync>>(Box::new(addrs.into_iter()))
        })
    }
}

/// The client used for real sites: HTTPS only, public addresses only, and at
/// most five redirects, none of them to a bare IP address.
fn public_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECONDS))
        .user_agent(USER_AGENT)
        .https_only(true)
        .dns_resolver(Arc::new(PublicResolver))
        .redirect(Policy::custom(|attempt| {
            let to_ip = attempt.url().host_str().is_none_or(is_ip_literal);

            if to_ip || attempt.previous().len() >= 5 {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| error.to_string())
}

/// Accepts a bare host, a host with a port, or a full URL and returns a safe
/// host name, or `None` when anything else is passed in.
fn normalize_host(raw: &str) -> Option<String> {
    let mut host = raw.trim().to_ascii_lowercase();

    for prefix in ["https://", "http://"] {
        if let Some(rest) = host.strip_prefix(prefix) {
            host = rest.to_string();
        }
    }

    host = host.split(['/', '?', '#']).next()?.to_string();

    if let Some((name, port)) = host.rsplit_once(':') {
        if port.chars().all(|c| c.is_ascii_digit()) {
            host = name.to_string();
        }
    }

    host = host.trim_end_matches('.').to_string();

    if host.is_empty()
        || host.len() > 253
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        return None;
    }

    if host == "localhost"
        || host.ends_with(".localhost")
        || is_ip_literal(&host)
        || host.split('.').any(|label| label.is_empty())
    {
        return None;
    }

    Some(host)
}

fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }

    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }

    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }

    if bytes.starts_with(b"\x00\x00\x01\x00") {
        return Some("image/x-icon");
    }

    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }

    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);

    if head.trim_start().starts_with("<svg") {
        return Some("image/svg+xml");
    }

    None
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

fn read_limited(response: reqwest::blocking::Response) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    response
        .take((MAX_ICON_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;

    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES {
        return None;
    }

    Some(bytes)
}

fn get_bytes(client: &Client, url: &str) -> Option<Vec<u8>> {
    let response = client.get(url).send().ok()?;

    if !response.status().is_success() {
        return None;
    }

    read_limited(response)
}

/// Reads one attribute value out of a single HTML tag.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut cursor = 0;

    while let Some(offset) = lower[cursor..].find(name) {
        let start = cursor + offset;
        let before_ok = start == 0 || !lower.as_bytes()[start - 1].is_ascii_alphanumeric();
        let rest = tag[start + name.len()..].trim_start();

        if let Some(value) = rest.strip_prefix('=') {
            if before_ok {
                let value = value.trim_start();
                let quote = value.chars().next()?;

                if quote == '"' || quote == '\'' {
                    let end = value[1..].find(quote)?;

                    return Some(value[1..1 + end].to_string());
                }

                let end = value
                    .find(|c: char| c.is_ascii_whitespace())
                    .unwrap_or(value.len());

                return Some(value[..end].to_string());
            }
        }

        cursor = start + name.len();
    }

    None
}

/// Finds the site icon link in a page, preferring the plain icon over the
/// apple touch icon.
fn icon_href(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    let mut apple = None;

    while let Some(offset) = lower[cursor..].find("<link") {
        let start = cursor + offset;
        let end = match lower[start..].find('>') {
            Some(index) => start + index,
            None => break,
        };
        let tag = &html[start..end];

        if let (Some(rel), Some(href)) = (attribute(tag, "rel"), attribute(tag, "href")) {
            let rel = rel.to_ascii_lowercase();

            if rel.contains("icon") && !href.trim().is_empty() {
                if rel.contains("apple") {
                    apple = apple.or(Some(href));
                } else {
                    return Some(href);
                }
            }
        }

        cursor = end + 1;
    }

    apple
}

fn resolve_href(base: &str, href: &str) -> Option<String> {
    let href = href.trim();

    // A link to another host must be HTTPS and name a host, not an IP address.
    let other_host = href
        .strip_prefix("https://")
        .or_else(|| href.strip_prefix("//"));

    if let Some(rest) = other_host {
        normalize_host(rest)?;
        return Some(format!("https://{rest}"));
    }

    if href.contains(':') && !href.starts_with('/') {
        // http:, data:, javascript: and other schemes.
        return None;
    }

    if let Some(rest) = href.strip_prefix('/') {
        return Some(format!("{base}/{rest}"));
    }

    if href.is_empty() {
        return None;
    }

    Some(format!("{base}/{href}"))
}

fn fetch_icon_at(client: &Client, base: &str) -> Option<(String, Vec<u8>)> {
    if let Some(bytes) = get_bytes(client, &format!("{base}/favicon.ico")) {
        if let Some(mime) = sniff_mime(&bytes) {
            return Some((mime.to_string(), bytes));
        }
    }

    let page = get_bytes(client, base)?;
    let html = String::from_utf8_lossy(&page);
    let href = icon_href(&html)?;
    let url = resolve_href(base, &href)?;
    let bytes = get_bytes(client, &url)?;
    let mime = sniff_mime(&bytes)?;

    Some((mime.to_string(), bytes))
}

/// Site icon for a host, as a data URL. Fetched once and cached on disk. Runs
/// on the blocking pool so the network wait never stalls the UI.
#[tauri::command]
pub async fn credential_icon(app: AppHandle, host: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || resolve_icon(&app, &host))
        .await
        .ok()
        .flatten()
}

fn resolve_icon(app: &AppHandle, host: &str) -> Option<String> {
    let host = normalize_host(host)?;
    let path = cache_dir(app)
        .ok()?
        .join(format!("{}.img", cache_name(&host)));

    if let Ok(bytes) = fs::read(&path) {
        if let Some(mime) = sniff_mime(&bytes) {
            return Some(data_url(mime, &bytes));
        }
    }

    let client = public_client().ok()?;
    let (mime, bytes) = fetch_icon_at(&client, &format!("https://{host}"))?;

    let _ = fs::write(&path, &bytes);

    Some(data_url(&mime, &bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nimage-bytes";

    /// Serves a fixed set of routes on a local port and returns the base URL.
    fn serve(routes: Vec<(String, u16, &'static str, Vec<u8>)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        thread::spawn(move || {
            // One extra accept covers a request that misses the route list and
            // gets the 404 fallback before the real routes are served.
            for _ in 0..routes.len() + 1 {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };

                let mut buffer = [0; 2048];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();

                let route = routes.iter().find(|route| route.0 == path);

                match route {
                    Some((_, status, content_type, body)) => {
                        let head = format!(
                            "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );

                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(body);
                    }
                    None => {
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                }
            }
        });

        format!("http://127.0.0.1:{port}")
    }

    #[test]
    fn normalizes_hosts() {
        assert_eq!(normalize_host("GitHub.com"), Some("github.com".to_string()));
        assert_eq!(
            normalize_host("https://github.com/login?x=1"),
            Some("github.com".to_string())
        );
        assert_eq!(
            normalize_host("github.com:8443"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn rejects_local_and_ip_hosts() {
        for host in [
            "localhost",
            "app.localhost",
            "127.0.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "https://10.0.0.1:8080/x",
        ] {
            assert_eq!(normalize_host(host), None, "{host}");
        }
    }

    #[test]
    fn only_public_addresses_pass() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }

        assert!(is_public("8.8.8.8".parse().unwrap()));
        assert!(is_public("2606:4700::1111".parse().unwrap()));
    }

    #[test]
    fn refuses_unsafe_icon_links() {
        let base = "https://a.com";

        assert_eq!(resolve_href(base, "http://cdn.com/i.png"), None);
        assert_eq!(resolve_href(base, "https://127.0.0.1/i.png"), None);
        assert_eq!(resolve_href(base, "//localhost/i.png"), None);
        assert_eq!(resolve_href(base, "data:image/png;base64,AAAA"), None);
        assert_eq!(
            resolve_href(base, "https://cdn.com/i.png"),
            Some("https://cdn.com/i.png".to_string())
        );
    }

    #[test]
    fn public_client_refuses_a_local_address() {
        let base = serve(vec![(
            "/favicon.ico".to_string(),
            200,
            "image/png",
            PNG.to_vec(),
        )]);
        let client = public_client().unwrap();

        assert!(fetch_icon_at(&client, &base).is_none());
    }

    #[test]
    fn rejects_unsafe_hosts() {
        assert_eq!(normalize_host(""), None);
        assert_eq!(
            normalize_host("github.com/../etc"),
            Some("github.com".to_string())
        );
        assert_eq!(normalize_host("user@github.com"), None);
        assert_eq!(normalize_host("github com"), None);
        assert_eq!(normalize_host("github..com"), None);
    }

    #[test]
    fn sniffs_image_types() {
        assert_eq!(sniff_mime(PNG), Some("image/png"));
        assert_eq!(
            sniff_mime(b"<svg xmlns=\"x\"></svg>"),
            Some("image/svg+xml")
        );
        assert_eq!(sniff_mime(b"<html></html>"), None);
    }

    #[test]
    fn cache_names_are_stable_hashes() {
        let name = cache_name("github.com");

        assert_eq!(name.len(), 64);
        assert!(name.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!name.contains("github"));
        assert_eq!(name, cache_name("github.com"));
    }

    #[test]
    fn reads_icon_links() {
        assert_eq!(
            icon_href(r#"<link rel="shortcut icon" href="/a.png">"#),
            Some("/a.png".to_string())
        );
        assert_eq!(
            icon_href(r#"<link href="/b.png" rel="icon">"#),
            Some("/b.png".to_string())
        );
        assert_eq!(
            icon_href(r#"<link rel="apple-touch-icon" href="/c.png">"#),
            Some("/c.png".to_string())
        );
        assert_eq!(icon_href("<html><body>plain</body></html>"), None);
    }

    #[test]
    fn resolves_relative_links() {
        assert_eq!(
            resolve_href("https://a.com", "//cdn.com/i.png"),
            Some("https://cdn.com/i.png".to_string())
        );
        assert_eq!(
            resolve_href("https://a.com", "i.png"),
            Some("https://a.com/i.png".to_string())
        );
        assert_eq!(
            resolve_href("https://a.com", "/i.png"),
            Some("https://a.com/i.png".to_string())
        );
    }

    #[test]
    fn fetches_the_root_favicon() {
        let base = serve(vec![(
            "/favicon.ico".to_string(),
            200,
            "image/png",
            PNG.to_vec(),
        )]);
        let client = client().unwrap();
        let (mime, bytes) = fetch_icon_at(&client, &base).unwrap();

        assert_eq!(mime, "image/png");
        assert_eq!(bytes, PNG);
    }

    #[test]
    fn falls_back_to_the_page_link() {
        let page = br#"<html><head><link rel="icon" href="/icon.png"></head></html>"#.to_vec();
        let base = serve(vec![
            ("/".to_string(), 200, "text/html", page),
            ("/icon.png".to_string(), 200, "image/png", PNG.to_vec()),
        ]);
        let client = client().unwrap();
        let (mime, bytes) = fetch_icon_at(&client, &base).unwrap();

        assert_eq!(mime, "image/png");
        assert_eq!(bytes, PNG);
    }
}
