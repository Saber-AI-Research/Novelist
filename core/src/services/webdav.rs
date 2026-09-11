use crate::AppError;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::{Client, Url};
use std::io::Read;
use std::path::{Component, Path};
use std::time::Duration;

// Bounds headers and streaming bodies, including clients supplied by commands.
#[cfg(not(test))]
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct WebDavAuth {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone)]
pub struct DavEntry {
    pub href: String,
    pub last_modified: Option<String>,
    pub content_length: Option<u64>,
    pub is_collection: bool,
}

fn invalid_path() -> AppError {
    AppError::InvalidInput("Invalid or unsafe WebDAV path".into())
}

/// Logical remote paths are never pre-encoded. Every component is encoded once.
pub(crate) fn validate_remote_path(path: &str) -> Result<(), AppError> {
    if path.is_empty() {
        return Ok(());
    }
    if path.split('/').any(|part| {
        part.is_empty()
            || part == "."
            || part == ".."
            || part.contains(['\\', '\0'])
            || part.chars().any(char::is_control)
    }) {
        return Err(invalid_path());
    }
    Ok(())
}

fn decode_component(value: &str) -> Result<String, AppError> {
    let mut decoded = Vec::with_capacity(value.len());
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let hi = bytes
                .next()
                .and_then(|c| (c as char).to_digit(16))
                .ok_or_else(invalid_path)?;
            let lo = bytes
                .next()
                .and_then(|c| (c as char).to_digit(16))
                .ok_or_else(invalid_path)?;
            decoded.push((hi * 16 + lo) as u8);
        } else {
            decoded.push(byte);
        }
    }
    let decoded = String::from_utf8(decoded).map_err(|_| invalid_path())?;
    if decoded.contains('/') {
        return Err(invalid_path());
    }
    validate_remote_path(&decoded)?;
    Ok(decoded)
}

fn decoded_path(path: &str) -> Result<Vec<String>, AppError> {
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path.strip_suffix('/').unwrap_or(path);
    if path.is_empty() {
        return Ok(Vec::new());
    }
    path.split('/').map(decode_component).collect()
}

/// Validate the raw path before Url can normalize away dot segments.
fn raw_url_path(value: &str) -> Result<&str, AppError> {
    let (_, authority_and_path) = value.split_once("://").ok_or_else(invalid_path)?;
    Ok(authority_and_path
        .find('/')
        .map(|i| &authority_and_path[i..])
        .unwrap_or("/"))
}

pub(crate) fn remote_url(base_url: &str, remote_path: &str) -> Result<Url, AppError> {
    let mut url = Url::parse(base_url).map_err(|_| invalid_path())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || base_url.contains('\\')
    {
        return Err(invalid_path());
    }
    decoded_path(raw_url_path(base_url)?)?;
    validate_remote_path(remote_path)?;
    if !remote_path.is_empty() {
        let mut segments = url.path_segments_mut().map_err(|_| invalid_path())?;
        segments.pop_if_empty();
        for segment in remote_path.split('/') {
            segments.push(segment);
        }
    }
    Ok(url)
}

/// Resolve an encoded DAV href to logical components, confined to the requested
/// collection. Do not decode twice: `%252F` names a literal `%2F`, not a slash.
pub(crate) fn relative_href(collection: &Url, href: &str) -> Result<String, AppError> {
    if href.contains(['?', '#', '\\']) {
        return Err(invalid_path());
    }
    let path = if href.contains("://") {
        let absolute = Url::parse(href).map_err(|_| invalid_path())?;
        if absolute.origin() != collection.origin()
            || !absolute.username().is_empty()
            || absolute.password().is_some()
        {
            return Err(invalid_path());
        }
        raw_url_path(href)?
    } else {
        href
    };
    let components = decoded_path(path)?;
    let base = decoded_path(collection.path())?;
    if href.starts_with('/') || href.contains("://") {
        let relative = components
            .strip_prefix(base.as_slice())
            .ok_or_else(invalid_path)?;
        Ok(relative.join("/"))
    } else {
        // RFC-relative hrefs are relative to the queried collection.
        Ok(components.join("/"))
    }
}

fn request_error(method: &str, error: reqwest::Error) -> AppError {
    AppError::Custom(format!("WebDAV {method} failed: {}", error.without_url()))
}

pub(crate) struct RemoteFile {
    pub bytes: Vec<u8>,
    pub etag: Option<String>,
}

pub(crate) async fn get_file(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    auth: &WebDavAuth,
) -> Result<RemoteFile, AppError> {
    let response = client
        .get(remote_url(base_url, remote_path)?)
        .timeout(REQUEST_TIMEOUT)
        .basic_auth(&auth.username, Some(&auth.password))
        .send()
        .await
        .map_err(|error| request_error("GET", error))?;
    if !response.status().is_success() {
        return Err(AppError::Custom(format!(
            "WebDAV GET returned {}",
            response.status()
        )));
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.starts_with("W/"))
        .map(str::to_owned);
    let bytes = response
        .bytes()
        .await
        .map_err(|error| request_error("GET body", error))?
        .to_vec();
    Ok(RemoteFile { bytes, etag })
}

pub(crate) enum PutCondition<'a> {
    Unconditional,
    Absent,
    Matches(&'a str),
}

pub(crate) async fn put_bytes(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    bytes: Vec<u8>,
    auth: &WebDavAuth,
    condition: PutCondition<'_>,
) -> Result<(), AppError> {
    let mut request = client
        .put(remote_url(base_url, remote_path)?)
        .timeout(REQUEST_TIMEOUT)
        .basic_auth(&auth.username, Some(&auth.password));
    request = match condition {
        PutCondition::Unconditional => request,
        PutCondition::Absent => request.header(reqwest::header::IF_NONE_MATCH, "*"),
        PutCondition::Matches(etag) => request.header(reqwest::header::IF_MATCH, etag),
    };
    let response = request
        .body(bytes)
        .send()
        .await
        .map_err(|error| request_error("PUT", error))?;
    if !response.status().is_success() {
        return Err(AppError::Custom(format!(
            "WebDAV PUT returned {}",
            response.status()
        )));
    }
    Ok(())
}

/// Open a relative parent chain without following a symlink at any component.
pub(crate) fn confined_parent(root: &Dir, relative: &Path, create: bool) -> Result<Dir, AppError> {
    let value = relative.to_str().ok_or_else(invalid_path)?;
    validate_remote_path(value)?;
    if value.is_empty() {
        return Err(invalid_path());
    }
    let mut dir = root.try_clone()?;
    let parent = relative.parent().ok_or_else(invalid_path)?;
    for component in parent.components() {
        let Component::Normal(name) = component else {
            return Err(invalid_path());
        };
        if create {
            match dir.create_dir(name) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        dir = dir.open_dir_nofollow(name)?;
    }
    Ok(dir)
}

pub(crate) fn read_confined(root: &Dir, relative: &Path) -> Result<Vec<u8>, AppError> {
    let parent = confined_parent(root, relative, false)?;
    let name = relative.file_name().ok_or_else(invalid_path)?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = parent.open_with(name, &options)?;
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(invalid_path());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if before.modified()? != after.modified()? || before.len() != after.len() {
        return Err(AppError::Custom("Local file changed while reading".into()));
    }
    Ok(bytes)
}

pub async fn list_remote(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    auth: &WebDavAuth,
) -> Result<Vec<DavEntry>, AppError> {
    let response = client.request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), remote_url(base_url, remote_path)?)
        .timeout(REQUEST_TIMEOUT)
        .basic_auth(&auth.username, Some(&auth.password))
        .header("Depth", "1").header("Content-Type", "application/xml")
        .body(r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>"#)
        .send().await.map_err(|error| request_error("PROPFIND", error))?;
    if !response.status().is_success() {
        return Err(AppError::Custom(format!(
            "WebDAV PROPFIND returned {}",
            response.status()
        )));
    }
    let xml = response
        .text()
        .await
        .map_err(|error| request_error("PROPFIND body", error))?;
    parse_propfind_response(&xml)
}

pub async fn create_collection(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    auth: &WebDavAuth,
) -> Result<(), AppError> {
    let response = client
        .request(
            reqwest::Method::from_bytes(b"MKCOL").unwrap(),
            remote_url(base_url, remote_path)?,
        )
        .basic_auth(&auth.username, Some(&auth.password))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| request_error("MKCOL", error))?;
    if !response.status().is_success() && response.status().as_u16() != 405 {
        return Err(AppError::Custom(format!(
            "WebDAV MKCOL returned {}",
            response.status()
        )));
    }
    Ok(())
}

pub async fn delete_remote(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    auth: &WebDavAuth,
) -> Result<(), AppError> {
    let response = client
        .delete(remote_url(base_url, remote_path)?)
        .timeout(REQUEST_TIMEOUT)
        .basic_auth(&auth.username, Some(&auth.password))
        .send()
        .await
        .map_err(|error| request_error("DELETE", error))?;
    if !response.status().is_success() && response.status().as_u16() != 404 {
        return Err(AppError::Custom(format!(
            "WebDAV DELETE returned {}",
            response.status()
        )));
    }
    Ok(())
}

pub async fn test_connection(
    client: &Client,
    base_url: &str,
    auth: &WebDavAuth,
) -> Result<bool, AppError> {
    let response = client.request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), remote_url(base_url, "")?)
        .timeout(REQUEST_TIMEOUT)
        .basic_auth(&auth.username, Some(&auth.password)).header("Depth", "0")
        .header("Content-Type", "application/xml")
        .body(r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#)
        .send().await.map_err(|error| request_error("connection test", error))?;
    Ok(response.status().is_success())
}

/// Parse XML structurally: namespace prefixes and escaped href text are not fixed.
fn parse_propfind_response(xml: &str) -> Result<Vec<DavEntry>, AppError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut entries = Vec::new();
    let mut current: Option<DavEntry> = None;
    let mut saw_multistatus = false;
    loop {
        match reader
            .read_event()
            .map_err(|_| AppError::Custom("Invalid WebDAV listing XML".into()))?
        {
            Event::Start(tag) => match tag.local_name().as_ref() {
                b"multistatus" => saw_multistatus = true,
                b"response" => {
                    if current.is_some() {
                        return Err(invalid_path());
                    }
                    current = Some(DavEntry {
                        href: String::new(),
                        last_modified: None,
                        content_length: None,
                        is_collection: false,
                    });
                }
                b"href" | b"getlastmodified" | b"getcontentlength" | b"status"
                    if current.is_some() =>
                {
                    let text = reader.read_text(tag.name()).map_err(|_| invalid_path())?;
                    let text = quick_xml::escape::unescape(&text).map_err(|_| invalid_path())?;
                    let entry = current.as_mut().unwrap();
                    match tag.local_name().as_ref() {
                        b"href" => entry.href = text.into_owned(),
                        b"getlastmodified" => entry.last_modified = Some(text.into_owned()),
                        b"getcontentlength" => entry.content_length = text.parse().ok(),
                        b"status" => {
                            let code = text
                                .split_whitespace()
                                .nth(1)
                                .and_then(|s| s.parse::<u16>().ok());
                            if !matches!(code, Some(200..=299) | Some(404)) {
                                return Err(AppError::Custom(
                                    "WebDAV listing contains a failed resource".into(),
                                ));
                            }
                        }
                        _ => {}
                    }
                }
                b"collection" if current.is_some() => {
                    current.as_mut().unwrap().is_collection = true
                }
                _ => {}
            },
            Event::Empty(tag) => match tag.local_name().as_ref() {
                b"multistatus" => saw_multistatus = true,
                b"collection" if current.is_some() => {
                    current.as_mut().unwrap().is_collection = true
                }
                _ => {}
            },
            Event::End(tag) if tag.local_name().as_ref() == b"response" => {
                let entry = current.take().ok_or_else(invalid_path)?;
                if entry.href.is_empty() {
                    return Err(invalid_path());
                }
                entries.push(entry);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !saw_multistatus || current.is_some() {
        return Err(AppError::Custom("Incomplete WebDAV listing".into()));
    }
    Ok(entries)
}

#[cfg(test)]
pub(crate) mod test_server {
    use std::collections::{BTreeMap, BTreeSet, HashSet};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[derive(Clone, Debug)]
    pub(crate) struct Request {
        pub method: String,
        pub path: String,
        pub body: Vec<u8>,
        pub headers: BTreeMap<String, String>,
    }

    #[derive(Default)]
    pub(crate) struct DavState {
        pub files: BTreeMap<String, Vec<u8>>,
        pub collections: BTreeSet<String>,
        pub requests: Vec<Request>,
        pub fail: HashSet<(String, String)>,
        pub stall: HashSet<(String, String)>,
        pub edit_local: Option<(String, String, PathBuf, Vec<u8>)>,
    }

    pub(crate) struct DavServer {
        pub url: String,
        pub state: Arc<Mutex<DavState>>,
        stop: Arc<AtomicBool>,
        address: std::net::SocketAddr,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl DavServer {
        pub fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            listener.set_nonblocking(true).unwrap();
            let state = Arc::new(Mutex::new(DavState::default()));
            state
                .lock()
                .unwrap()
                .collections
                .insert("/dav/base%20path".into());
            let shared = state.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let thread = std::thread::spawn(move || {
                let mut connections = Vec::new();
                while !stopped.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            if stopped.load(Ordering::Relaxed) {
                                break;
                            }
                            // Accepted sockets inherit O_NONBLOCK on some platforms.
                            // Handle connections independently so speculative/idle
                            // connections cannot starve the request under test.
                            let shared = shared.clone();
                            let stopped = stopped.clone();
                            connections.push(std::thread::spawn(move || {
                                if stream.set_nonblocking(false).is_err()
                                    || stream.set_read_timeout(Some(Duration::from_secs(2))).is_err()
                                    || stream.set_write_timeout(Some(Duration::from_secs(2))).is_err()
                                { return; }
                                let Some(request) = read_request(&mut stream) else { return; };
                                loop {
                                    if stopped.load(Ordering::Relaxed) { return; }
                                    let stalled = shared.lock().unwrap().stall.contains(&(request.method.clone(), request.path.clone()));
                                    if !stalled { break; }
                                    std::thread::sleep(Duration::from_millis(1));
                                }
                                let (code, body, etag) = respond(&mut shared.lock().unwrap(), &request);
                                let etag_header = etag.map(|value| format!("ETag: {value}\r\n")).unwrap_or_default();
                                if write!(stream, "HTTP/1.1 {code} Test\r\nContent-Length: {}\r\n{etag_header}Connection: close\r\n\r\n", body.len()).is_ok() {
                                    let _ = stream.write_all(&body);
                                }
                            }));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(1))
                        }
                        Err(error) => panic!("localhost DAV accept failed: {error}"),
                    }
                }
                for connection in connections {
                    let _ = connection.join();
                }
            });
            Self {
                url: format!("http://{address}/dav/base%20path"),
                state,
                stop,
                address,
                thread: Some(thread),
            }
        }
    }

    impl Drop for DavServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            let _ = TcpStream::connect(self.address);
            if let Some(thread) = self.thread.take() {
                // Do not double-panic while unwinding a failed test assertion.
                let _ = thread.join();
            }
        }
    }

    fn read_request(stream: &mut TcpStream) -> Option<Request> {
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut buffer = [0; 4096];
            let length = stream.read(&mut buffer).ok()?;
            if length == 0 {
                return None;
            }
            bytes.extend_from_slice(&buffer[..length]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let head = std::str::from_utf8(&bytes[..header_end]).ok()?;
        let mut lines = head.lines();
        let mut first = lines.next()?.split_whitespace();
        let method = first.next()?.to_string();
        let path = first.next()?.to_string();
        let headers: BTreeMap<String, String> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        let length = headers
            .get("content-length")
            .map(|value| value.parse::<usize>())
            .transpose()
            .ok()?
            .unwrap_or(0);
        while bytes.len() < header_end + length {
            let mut buffer = [0; 4096];
            let count = stream.read(&mut buffer).ok()?;
            if count == 0 {
                return None;
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
        Some(Request {
            method,
            path,
            headers,
            body: bytes[header_end..header_end + length].to_vec(),
        })
    }

    fn etag(bytes: &[u8]) -> String {
        format!("\"{}\"", blake3::hash(bytes).to_hex())
    }

    fn respond(state: &mut DavState, request: &Request) -> (u16, Vec<u8>, Option<String>) {
        state.requests.push(request.clone());
        if let Some((method, path, _, _)) = &state.edit_local {
            if method == &request.method && path == &request.path {
                let (_, _, local, bytes) = state.edit_local.take().unwrap();
                std::fs::write(local, bytes).unwrap();
            }
        }
        if state
            .fail
            .contains(&(request.method.clone(), request.path.clone()))
        {
            return (500, Vec::new(), None);
        }
        let path = request.path.trim_end_matches('/');
        match request.method.as_str() {
            "MKCOL" => {
                if state.collections.contains(path) {
                    return (405, Vec::new(), None);
                }
                let parent = path.rsplit_once('/').unwrap().0;
                if !state.collections.contains(parent) {
                    return (409, Vec::new(), None);
                }
                state.collections.insert(path.to_string());
                (201, Vec::new(), None)
            }
            "PUT" => {
                if request.headers.get("if-none-match").map(String::as_str) == Some("*")
                    && state.files.contains_key(path)
                {
                    return (412, Vec::new(), None);
                }
                if let Some(expected) = request.headers.get("if-match") {
                    if state.files.get(path).map(|bytes| etag(bytes)).as_ref() != Some(expected) {
                        return (412, Vec::new(), None);
                    }
                }
                if !state.collections.contains(path.rsplit_once('/').unwrap().0) {
                    return (409, Vec::new(), None);
                }
                state.files.insert(path.to_string(), request.body.clone());
                (201, Vec::new(), Some(etag(&request.body)))
            }
            "GET" => match state.files.get(path) {
                Some(bytes) => (200, bytes.clone(), Some(etag(bytes))),
                None => (404, Vec::new(), None),
            },
            "DELETE" => {
                state.files.remove(path);
                (204, Vec::new(), None)
            }
            "PROPFIND" => {
                if !state.collections.contains(path) {
                    return (404, Vec::new(), None);
                }
                let prefix = format!("{path}/");
                let mut xml = String::from("<x:multistatus xmlns:x=\"DAV:\">");
                let mut entry = |href: &str, collection: bool| {
                    let href = quick_xml::escape::escape(href);
                    xml.push_str(&format!("<x:response><x:href>{href}</x:href><x:propstat><x:prop><x:resourcetype>{}</x:resourcetype></x:prop><x:status>HTTP/1.1 200 OK</x:status></x:propstat></x:response>", if collection { "<x:collection/>" } else { "" }));
                };
                entry(&prefix, true);
                if request.headers.get("depth").map(String::as_str) != Some("0") {
                    for directory in &state.collections {
                        if directory
                            .strip_prefix(&prefix)
                            .is_some_and(|child| !child.is_empty() && !child.contains('/'))
                        {
                            entry(&format!("{directory}/"), true);
                        }
                    }
                    for file in state.files.keys() {
                        if file
                            .strip_prefix(&prefix)
                            .is_some_and(|child| !child.contains('/'))
                        {
                            entry(file, false);
                        }
                    }
                }
                xml.push_str("</x:multistatus>");
                (207, xml.into_bytes(), None)
            }
            _ => (405, Vec::new(), None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_server::DavServer;
    use super::*;

    #[tokio::test]
    async fn every_method_encodes_nested_cjk_reserved_characters_once() {
        let server = DavServer::start();
        let client = Client::new();
        let auth = WebDavAuth {
            username: "test".into(),
            password: "not-a-credential".into(),
        };
        let directory = "小说 #?%";
        let filename = "第一章#?%2F&.md";
        let logical = format!("{directory}/{filename}");
        create_collection(&client, &server.url, directory, &auth)
            .await
            .unwrap();
        put_bytes(
            &client,
            &server.url,
            &logical,
            b"chapter".to_vec(),
            &auth,
            PutCondition::Absent,
        )
        .await
        .unwrap();
        assert_eq!(
            get_file(&client, &server.url, &logical, &auth)
                .await
                .unwrap()
                .bytes,
            b"chapter"
        );
        let entries = list_remote(&client, &server.url, directory, &auth)
            .await
            .unwrap();
        let collection = remote_url(&server.url, directory).unwrap();
        assert_eq!(
            relative_href(
                &collection,
                &entries
                    .iter()
                    .find(|entry| !entry.is_collection)
                    .unwrap()
                    .href
            )
            .unwrap(),
            filename
        );
        delete_remote(&client, &server.url, &logical, &auth)
            .await
            .unwrap();
        assert!(test_connection(&client, &server.url, &auth).await.unwrap());
        let expected_directory = "/dav/base%20path/%E5%B0%8F%E8%AF%B4%20%23%3F%25";
        let expected_file =
            format!("{expected_directory}/%E7%AC%AC%E4%B8%80%E7%AB%A0%23%3F%252F&.md");
        let state = server.state.lock().unwrap();
        for method in ["PUT", "GET", "DELETE"] {
            assert!(state
                .requests
                .iter()
                .any(|request| request.method == method && request.path == expected_file));
        }
        for method in ["MKCOL", "PROPFIND"] {
            assert!(state
                .requests
                .iter()
                .any(|request| request.method == method && request.path == expected_directory));
        }
        assert!(!state.files.contains_key(&expected_file));
        assert_ne!(
            remote_url(&server.url, "a#b.md").unwrap(),
            remote_url(&server.url, "a%23b.md").unwrap()
        );
    }

    #[test]
    fn rejects_ambiguous_config_and_escaping_hrefs() {
        for base in [
            "https://example.com/dav#fragment",
            "https://example.com/dav?query",
            "https://user:secret@example.com/dav",
            "https://example.com/dav/../other",
            "https://example.com/dav/%2e%2e/other",
            "https://example.com/dav/%2Fother",
        ] {
            let error = remote_url(base, "chapter.md").unwrap_err().to_string();
            assert!(!error.contains("secret"));
        }
        let collection = remote_url("https://example.com/dav/base%20path", "小说").unwrap();
        for href in [
            "../escape.md",
            "%2e%2e/escape.md",
            "%2Fescape.md",
            "sub%5cescape.md",
            "%FF.md",
            "/different/chapter.md",
            "chapter.md#fragment",
        ] {
            assert!(relative_href(&collection, href).is_err(), "{href}");
        }
        assert_eq!(relative_href(&collection, "%252F.md").unwrap(), "%2F.md");
    }

    #[test]
    fn invalid_listing_is_not_an_empty_remote_directory() {
        assert!(parse_propfind_response("<html>login</html>").is_err());
        assert!(parse_propfind_response("<d:multistatus xmlns:d=\"DAV:\"><d:response>").is_err());
        assert!(parse_propfind_response("<multistatus><response><href>/file.md</href><status>HTTP/1.1 403 Forbidden</status></response></multistatus>").is_err());
    }

    #[tokio::test]
    async fn connection_test_bounds_a_stalled_response_even_with_default_client() {
        let server = DavServer::start();
        server
            .state
            .lock()
            .unwrap()
            .stall
            .insert(("PROPFIND".into(), "/dav/base%20path".into()));
        let client = Client::new();
        let auth = WebDavAuth {
            username: "test".into(),
            password: "not-a-credential".into(),
        };
        let result = tokio::time::timeout(
            REQUEST_TIMEOUT * 3,
            test_connection(&client, &server.url, &auth),
        )
        .await
        .expect("WebDAV request deadline must precede watchdog");
        assert!(result.is_err());
        server.state.lock().unwrap().stall.clear();
        assert!(test_connection(&client, &server.url, &auth).await.unwrap());
    }
}
