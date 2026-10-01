use std::io::Read;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use dom_query::Document;
use reqwest::blocking::Client;
use reqwest::dns::Resolve;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::redirect::Policy;
use reqwest::Url;
use serde::Serialize;

use crate::icons::PublicResolver;

const MAX_URL_LENGTH: usize = 2048;
const MAX_REDIRECTS: usize = 3;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
const TITLE_MAX: usize = 512;
const DESCRIPTION_MAX: usize = 2000;
const USER_AGENT: &str = "Kivo";

const INVALID_URL: &str = "Enter a full http:// or https:// address.";
const PRIVATE_URL: &str = "Kivo only reads details from public websites.";
const REDIRECT_ERROR: &str = "The link redirects somewhere Kivo cannot open.";
const TIMEOUT_ERROR: &str = "The site took too long to answer.";
const REACH_ERROR: &str = "Kivo could not reach this site.";
const NOT_HTML: &str = "This link is not a web page.";
const TOO_LARGE: &str = "This page is too large to read.";

/// What a public page says about itself. `None` means the page did not
/// provide that field. `requested_url` is the address the user typed, never a
/// redirect target, so the saved link stays the one they chose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkDetails {
    pub requested_url: String,
    pub title: Option<String>,
    pub description: Option<String>,
}

/// Collapses whitespace, drops control characters, and caps the length.
/// Empty results become `None` so a blank tag never clears a field.
fn clean(raw: &str, max: usize) -> Option<String> {
    let text = raw
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if text.is_empty() {
        return None;
    }

    Some(text.chars().take(max).collect())
}

/// Title: `og:title`, then `<title>`. Description: `og:description`, then
/// `meta name=description`. The HTML parser decodes entities; results are
/// plain text and are never rendered as HTML.
fn parse_details(html: &str) -> (Option<String>, Option<String>) {
    let document = Document::from(html);
    let mut og_title = None;
    let mut og_description = None;
    let mut description = None;

    for meta in document.select("meta").nodes() {
        let key = meta
            .attr("property")
            .or_else(|| meta.attr("name"))
            .map(|value| value.trim().to_ascii_lowercase());
        let Some(content) = meta.attr("content") else {
            continue;
        };

        match key.as_deref() {
            Some("og:title") => og_title = og_title.or_else(|| clean(&content, TITLE_MAX)),
            Some("og:description") => {
                og_description = og_description.or_else(|| clean(&content, DESCRIPTION_MAX))
            }
            Some("description") => {
                description = description.or_else(|| clean(&content, DESCRIPTION_MAX))
            }
            _ => {}
        }
    }

    let title = og_title.or_else(|| clean(&document.select("title").first().text(), TITLE_MAX));

    (title, og_description.or(description))
}

/// Accepts only public-looking HTTP(S) addresses: no credentials, no IP
/// literals, no localhost, no single-label names. Names are still resolved
/// through `PublicResolver`, which drops private answers at connect time.
fn checked_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();

    if raw.len() > MAX_URL_LENGTH {
        return Err(INVALID_URL.to_string());
    }

    let url = Url::parse(raw).map_err(|_| INVALID_URL.to_string())?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err(INVALID_URL.to_string());
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err(INVALID_URL.to_string());
    }

    let host = url
        .host_str()
        .ok_or_else(|| INVALID_URL.to_string())?
        .trim_end_matches('.')
        .to_ascii_lowercase();

    if host == "localhost"
        || host.ends_with(".localhost")
        || host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok()
        || !host.contains('.')
    {
        return Err(PRIVATE_URL.to_string());
    }

    Ok(url)
}

/// Every hop, including redirects, resolves through `resolver`, and reqwest
/// connects only to the addresses it returns. Ambient proxies are off so a
/// proxy cannot reach what the resolver refused.
fn build_client<R: Resolve + 'static>(resolver: Arc<R>, timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .timeout(timeout)
        .user_agent(USER_AGENT)
        .no_proxy()
        .dns_resolver(resolver)
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() > MAX_REDIRECTS {
                attempt.error(REDIRECT_ERROR)
            } else if checked_url(attempt.url().as_str()).is_err() {
                attempt.error(REDIRECT_ERROR)
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| REACH_ERROR.to_string())
}

fn fetch_with(client: &Client, raw: &str) -> Result<LinkDetails, String> {
    let url = checked_url(raw)?;
    let response = client
        .get(url)
        .header(ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .map_err(|error| {
            if error.is_timeout() {
                TIMEOUT_ERROR.to_string()
            } else if error.is_redirect() {
                REDIRECT_ERROR.to_string()
            } else {
                REACH_ERROR.to_string()
            }
        })?;

    // reqwest hands back redirects it will not follow (such as to `file:`).
    if response.status().is_redirection() {
        return Err(REDIRECT_ERROR.to_string());
    }

    if !response.status().is_success() {
        return Err(format!("The site answered with status {}.", response.status().as_u16()));
    }

    let is_html = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|value| value.contains("text/html") || value.contains("application/xhtml+xml"));

    if !is_html {
        return Err(NOT_HTML.to_string());
    }

    let mut body = Vec::new();
    response
        .take((MAX_BODY_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|error| {
            if error.to_string().contains("timed out") {
                TIMEOUT_ERROR.to_string()
            } else {
                REACH_ERROR.to_string()
            }
        })?;

    if body.len() > MAX_BODY_BYTES {
        return Err(TOO_LARGE.to_string());
    }

    // ponytail: assumes UTF-8 (lossy); honor the page charset if non-UTF-8 sites matter.
    let (title, description) = parse_details(&String::from_utf8_lossy(&body));

    Ok(LinkDetails {
        requested_url: raw.trim().to_string(),
        title,
        description,
    })
}

/// Reads the title and description of a public page. Runs on the blocking
/// pool and never touches the database, so a slow site cannot stall the vault.
#[tauri::command]
pub async fn fetch_link_details(url: String) -> Result<LinkDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(Arc::new(PublicResolver), TIMEOUT)?;
        fetch_with(&client, &url)
    })
    .await
    .map_err(|_| REACH_ERROR.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::icons::public_addrs;
    use reqwest::dns::{Addrs, Name, Resolving};
    use std::io::Write;
    use std::net::{SocketAddr, TcpListener};
    use std::thread;

    // ---- Parser ----

    #[test]
    fn open_graph_wins_over_title_and_description() {
        let html = r#"<html><head>
            <title>Plain title</title>
            <meta name="description" content="Plain description">
            <meta property="og:title" content="OG title">
            <meta property="og:description" content="OG description">
        </head></html>"#;

        assert_eq!(
            parse_details(html),
            (Some("OG title".into()), Some("OG description".into()))
        );
    }

    #[test]
    fn falls_back_to_title_and_standard_description() {
        let html = r#"<title> Plain   title </title><meta name="description" content="Plain description">"#;

        assert_eq!(
            parse_details(html),
            (Some("Plain title".into()), Some("Plain description".into()))
        );
    }

    #[test]
    fn decodes_entities_and_accepts_any_attribute_order_and_case() {
        let html = r#"<META CONTENT="Tom &amp; Jerry &#8212; &quot;cartoon&quot;" PROPERTY="OG:Title">
            <meta content='Caf&eacute; menu' Name='Description'>"#;

        assert_eq!(
            parse_details(html),
            (
                Some("Tom & Jerry \u{2014} \"cartoon\"".into()),
                Some("Café menu".into())
            )
        );
    }

    #[test]
    fn malformed_html_still_yields_what_it_can() {
        let html = "<html><head><title>Broken <b>page</title><meta name=description content=unquoted";

        let (title, _) = parse_details(html);
        assert_eq!(title, Some("Broken <b>page".into()));
    }

    #[test]
    fn missing_or_blank_metadata_is_none() {
        assert_eq!(parse_details("<html><body>No head</body></html>"), (None, None));
        assert_eq!(
            parse_details(r#"<title>   </title><meta property="og:title" content="">"#),
            (None, None)
        );
    }

    #[test]
    fn strips_control_characters_and_caps_length() {
        let long = "a".repeat(TITLE_MAX + 50);
        let html = format!("<title>{long}</title><meta name=description content=\"one\u{0007}two\">");

        let (title, description) = parse_details(&html);
        assert_eq!(title.unwrap().chars().count(), TITLE_MAX);
        assert_eq!(description, Some("one two".into()));
    }

    // ---- Address checks ----

    #[test]
    fn accepts_public_http_and_https_addresses() {
        assert!(checked_url("https://example.com/page?q=1").is_ok());
        assert!(checked_url("  http://example.com  ").is_ok());
    }

    #[test]
    fn refuses_other_schemes_credentials_and_local_hosts() {
        for raw in [
            "ftp://example.com",
            "file:///C:/secret.txt",
            "javascript:alert(1)",
            "example.com",
            "https://user:pass@example.com",
            "https://user@example.com",
            "http://localhost:8080",
            "http://app.localhost",
            "http://127.0.0.1",
            "http://2130706433",
            "http://0x7f.0.0.1",
            "http://10.0.0.5",
            "http://192.168.1.1",
            "http://169.254.169.254/latest",
            "http://0.0.0.0",
            "http://[::1]",
            "http://[fe80::1]",
            "http://[::ffff:127.0.0.1]",
            "http://8.8.8.8",
            "http://intranet",
        ] {
            assert!(checked_url(raw).is_err(), "{raw}");
        }
        assert!(checked_url(&format!("https://example.com/{}", "a".repeat(MAX_URL_LENGTH))).is_err());
    }

    #[test]
    fn mixed_dns_answers_keep_only_public_addresses() {
        let mixed: Vec<SocketAddr> = ["127.0.0.1:0", "93.184.216.34:0", "10.0.0.1:0", "[fe80::1]:0"]
            .iter()
            .map(|addr| addr.parse().unwrap())
            .collect();

        assert_eq!(
            public_addrs(mixed.into_iter()),
            vec!["93.184.216.34:0".parse::<SocketAddr>().unwrap()]
        );
        for private in ["224.0.0.1:0", "100.64.0.1:0", "[fc00::1]:0", "[::]:0"] {
            assert!(public_addrs(std::iter::once(private.parse().unwrap())).is_empty(), "{private}");
        }
    }

    // ---- Network flow, through an injected resolver ----

    /// Fake DNS: `site.test` points at the local test server; every other
    /// name gets its listed answers filtered exactly like the real resolver.
    struct FakeDns(Vec<(&'static str, Vec<&'static str>)>);

    impl Resolve for FakeDns {
        fn resolve(&self, name: Name) -> Resolving {
            let host = name.as_str().to_string();
            let answers: Vec<SocketAddr> = self
                .0
                .iter()
                .find(|(name, _)| *name == host)
                .map(|(_, ips)| {
                    ips.iter()
                        .map(|ip| SocketAddr::new(ip.parse().unwrap(), 0))
                        .collect()
                })
                .unwrap_or_default();
            let addrs = if host == "site.test" { answers } else { public_addrs(answers.into_iter()) };

            Box::pin(async move {
                if addrs.is_empty() {
                    return Err("no public address".into());
                }
                Ok::<Addrs, Box<dyn std::error::Error + Send + Sync>>(Box::new(addrs.into_iter()))
            })
        }
    }

    fn test_client(timeout: Duration) -> Client {
        build_client(
            Arc::new(FakeDns(vec![
                ("site.test", vec!["127.0.0.1"]),
                ("private.test", vec!["10.0.0.7", "192.168.0.2"]),
            ])),
            timeout,
        )
        .unwrap()
    }

    /// Answers each request with the next raw response, then returns the port.
    fn serve(responses: Vec<Vec<u8>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buffer = [0; 2048];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(&response);
            }
        });

        port
    }

    fn html_response(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn redirect_to(location: &str) -> Vec<u8> {
        format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .into_bytes()
    }

    #[test]
    fn reads_details_and_keeps_the_requested_url() {
        let port = serve(vec![html_response(
            r#"<title>Hello</title><meta name="description" content="World">"#,
        )]);
        let raw = format!("http://site.test:{port}/a");

        assert_eq!(
            fetch_with(&test_client(TIMEOUT), &raw).unwrap(),
            LinkDetails {
                requested_url: raw.clone(),
                title: Some("Hello".into()),
                description: Some("World".into()),
            }
        );
    }

    #[test]
    fn follows_a_redirect_but_reports_the_original_address() {
        let port = serve(vec![
            redirect_to("/final"),
            html_response("<title>Final</title>"),
        ]);
        let raw = format!("http://site.test:{port}/start");
        let details = fetch_with(&test_client(TIMEOUT), &raw).unwrap();

        assert_eq!(details.requested_url, raw);
        assert_eq!(details.title, Some("Final".into()));
    }

    #[test]
    fn refuses_redirects_to_local_or_private_destinations() {
        for target in [
            "http://127.0.0.1/admin",
            "http://localhost/admin",
            "http://[::1]/admin",
            "file:///C:/Windows/win.ini",
        ] {
            let port = serve(vec![redirect_to(target)]);
            let error = fetch_with(&test_client(TIMEOUT), &format!("http://site.test:{port}/")).unwrap_err();
            assert_eq!(error, REDIRECT_ERROR, "{target}");
        }

        // A name whose DNS answers are all private never gets a connection.
        let port = serve(vec![redirect_to("http://private.test/admin")]);
        assert!(fetch_with(&test_client(TIMEOUT), &format!("http://site.test:{port}/")).is_err());
    }

    #[test]
    fn stops_after_three_redirects() {
        let port = serve(vec![
            redirect_to("/1"),
            redirect_to("/2"),
            redirect_to("/3"),
            redirect_to("/4"),
            html_response("<title>Too far</title>"),
        ]);
        let error = fetch_with(&test_client(TIMEOUT), &format!("http://site.test:{port}/")).unwrap_err();

        assert_eq!(error, REDIRECT_ERROR);
    }

    #[test]
    fn refuses_non_html_and_oversized_pages() {
        let image = b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc".to_vec();
        let port = serve(vec![image]);
        assert_eq!(
            fetch_with(&test_client(TIMEOUT), &format!("http://site.test:{port}/")).unwrap_err(),
            NOT_HTML
        );

        let huge = format!("<title>x</title>{}", " ".repeat(MAX_BODY_BYTES + 10));
        let port = serve(vec![html_response(&huge)]);
        assert_eq!(
            fetch_with(&test_client(TIMEOUT), &format!("http://site.test:{port}/")).unwrap_err(),
            TOO_LARGE
        );
    }

    #[test]
    fn a_silent_site_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hold = thread::spawn(move || {
            let accepted = listener.accept();
            thread::sleep(Duration::from_millis(1500));
            drop(accepted);
        });

        let error = fetch_with(
            &test_client(Duration::from_millis(300)),
            &format!("http://site.test:{port}/"),
        )
        .unwrap_err();
        assert_eq!(error, TIMEOUT_ERROR);
        let _ = hold.join();
    }

    #[test]
    fn production_client_refuses_the_local_test_server() {
        // The real resolver drops loopback answers, so even a public-looking
        // URL that resolves locally never connects.
        let client = build_client(Arc::new(PublicResolver), TIMEOUT).unwrap();
        assert!(fetch_with(&client, "http://localhost:1/").is_err());
        assert!(fetch_with(&client, "http://127.0.0.1:1/").is_err());
    }
}
