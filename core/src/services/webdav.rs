use crate::AppError;
use reqwest::Client;
use std::path::Path;

/// Basic auth credentials for WebDAV
#[derive(Clone)]
pub struct WebDavAuth {
    pub username: String,
    pub password: String,
}

/// A single entry from a PROPFIND response
#[derive(Debug, Clone)]
pub struct DavEntry {
    pub href: String,
    pub last_modified: Option<String>,
    #[allow(dead_code)]
    pub content_length: Option<u64>,
    pub is_collection: bool,
}

/// Upload a local file to the WebDAV server via PUT
pub async fn upload_file(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    local_path: &Path,
    auth: &WebDavAuth,
) -> Result<(), AppError> {
    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        remote_path.trim_start_matches('/')
    );
    let body = tokio::fs::read(local_path).await?;
    let resp = client
        .put(&url)
        .basic_auth(&auth.username, Some(&auth.password))
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("WebDAV PUT failed: {e}")))?;
    if !resp.status().is_success() && resp.status().as_u16() != 201 && resp.status().as_u16() != 204
    {
        return Err(AppError::Custom(format!(
            "WebDAV PUT {} returned {}",
            url,
            resp.status()
        )));
    }
    Ok(())
}

/// Download a remote file from the WebDAV server via GET
pub async fn download_file(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    local_path: &Path,
    auth: &WebDavAuth,
) -> Result<(), AppError> {
    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        remote_path.trim_start_matches('/')
    );
    let resp = client
        .get(&url)
        .basic_auth(&auth.username, Some(&auth.password))
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("WebDAV GET failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Custom(format!(
            "WebDAV GET {} returned {}",
            url,
            resp.status()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Custom(format!("WebDAV GET body read failed: {e}")))?;
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(local_path, &bytes).await?;
    Ok(())
}

/// List remote files via PROPFIND (depth 1)
pub async fn list_remote(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    auth: &WebDavAuth,
) -> Result<Vec<DavEntry>, AppError> {
    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        remote_path.trim_start_matches('/')
    );
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>"#;

    let resp = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
        .basic_auth(&auth.username, Some(&auth.password))
        .header("Depth", "1")
        .header("Content-Type", "application/xml")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("WebDAV PROPFIND failed: {e}")))?;

    if !resp.status().is_success() && resp.status().as_u16() != 207 {
        return Err(AppError::Custom(format!(
            "WebDAV PROPFIND {} returned {}",
            url,
            resp.status()
        )));
    }

    let xml = resp
        .text()
        .await
        .map_err(|e| AppError::Custom(format!("WebDAV PROPFIND body read failed: {e}")))?;

    Ok(parse_propfind_response(&xml))
}

/// Create a collection (directory) via MKCOL
pub async fn create_collection(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    auth: &WebDavAuth,
) -> Result<(), AppError> {
    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        remote_path.trim_start_matches('/')
    );
    let resp = client
        .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &url)
        .basic_auth(&auth.username, Some(&auth.password))
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("WebDAV MKCOL failed: {e}")))?;
    // 201 Created, 405 Already Exists — both are fine
    if !resp.status().is_success() && resp.status().as_u16() != 405 {
        return Err(AppError::Custom(format!(
            "WebDAV MKCOL {} returned {}",
            url,
            resp.status()
        )));
    }
    Ok(())
}

/// Delete a remote resource
#[allow(dead_code)]
pub async fn delete_remote(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    auth: &WebDavAuth,
) -> Result<(), AppError> {
    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        remote_path.trim_start_matches('/')
    );
    let resp = client
        .delete(&url)
        .basic_auth(&auth.username, Some(&auth.password))
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("WebDAV DELETE failed: {e}")))?;
    if !resp.status().is_success() && resp.status().as_u16() != 204 && resp.status().as_u16() != 404
    {
        return Err(AppError::Custom(format!(
            "WebDAV DELETE {} returned {}",
            url,
            resp.status()
        )));
    }
    Ok(())
}

/// Test connection by doing a PROPFIND on the root
pub async fn test_connection(
    client: &Client,
    base_url: &str,
    auth: &WebDavAuth,
) -> Result<bool, AppError> {
    let url = base_url.trim_end_matches('/');
    let resp = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url)
        .basic_auth(&auth.username, Some(&auth.password))
        .header("Depth", "0")
        .header("Content-Type", "application/xml")
        .body(r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#)
        .send()
        .await
        .map_err(|e| AppError::Custom(format!("WebDAV connection test failed: {e}")))?;

    Ok(resp.status().is_success() || resp.status().as_u16() == 207)
}

/// Minimal XML parser for PROPFIND multistatus responses.
/// Extracts href, getlastmodified, getcontentlength, and whether it's a collection.
fn parse_propfind_response(xml: &str) -> Vec<DavEntry> {
    let mut entries = Vec::new();

    // Split on <d:response> or <D:response> boundaries
    let response_tag_starts: Vec<usize> = xml
        .match_indices("<d:response>")
        .chain(xml.match_indices("<D:response>"))
        .map(|(i, _)| i)
        .collect();

    for &start in &response_tag_starts {
        let rest = &xml[start..];
        let end = rest
            .find("</d:response>")
            .or_else(|| rest.find("</D:response>"))
            .unwrap_or(rest.len());
        let block = &rest[..end];

        let href = extract_tag_content(block, "href").unwrap_or_default();
        let last_modified = extract_tag_content(block, "getlastmodified");
        let content_length =
            extract_tag_content(block, "getcontentlength").and_then(|s| s.parse::<u64>().ok());
        let is_collection = block.contains("<d:collection") || block.contains("<D:collection");

        entries.push(DavEntry {
            href,
            last_modified,
            content_length,
            is_collection,
        });
    }

    entries
}

/// Extract text content from a DAV XML tag, handling both d: and D: prefixes
fn extract_tag_content(xml: &str, tag_local: &str) -> Option<String> {
    for prefix in &["d:", "D:", ""] {
        let open = format!("<{}{}>", prefix, tag_local);
        let close = format!("</{}{}>", prefix, tag_local);
        if let Some(start) = xml.find(&open) {
            let content_start = start + open.len();
            if let Some(end) = xml[content_start..].find(&close) {
                let val = xml[content_start..content_start + end].trim().to_string();
                if !val.is_empty() {
                    return Some(val);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_tag_content_d_prefix() {
        let xml = "<d:href>/remote/path</d:href>";
        assert_eq!(
            extract_tag_content(xml, "href"),
            Some("/remote/path".to_string())
        );
    }

    #[test]
    fn test_extract_tag_content_uppercase_prefix() {
        let xml = "<D:getlastmodified>Mon, 01 Jan 2024 12:00:00 GMT</D:getlastmodified>";
        assert_eq!(
            extract_tag_content(xml, "getlastmodified"),
            Some("Mon, 01 Jan 2024 12:00:00 GMT".to_string())
        );
    }

    #[test]
    fn test_extract_tag_content_no_prefix() {
        let xml = "<href>/path</href>";
        assert_eq!(extract_tag_content(xml, "href"), Some("/path".to_string()));
    }

    #[test]
    fn test_extract_tag_content_missing() {
        let xml = "<d:other>value</d:other>";
        assert_eq!(extract_tag_content(xml, "href"), None);
    }

    #[test]
    fn test_extract_tag_content_empty() {
        let xml = "<d:href></d:href>";
        assert_eq!(extract_tag_content(xml, "href"), None);
    }

    #[test]
    fn test_parse_propfind_empty() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>"#;
        let entries = parse_propfind_response(xml);
        assert!(entries.is_empty());
    }

    #[test]
    fn test_parse_propfind_single_file() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/novelist/project/chapter1.md</d:href>
    <d:propstat>
      <d:prop>
        <d:getlastmodified>Mon, 01 Jan 2024 12:00:00 GMT</d:getlastmodified>
        <d:getcontentlength>1234</d:getcontentlength>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>"#;
        let entries = parse_propfind_response(xml);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].href, "/novelist/project/chapter1.md");
        assert_eq!(
            entries[0].last_modified.as_deref(),
            Some("Mon, 01 Jan 2024 12:00:00 GMT")
        );
        assert_eq!(entries[0].content_length, Some(1234));
        assert!(!entries[0].is_collection);
    }

    #[test]
    fn test_parse_propfind_collection() {
        let xml = r#"<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/novelist/project/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>"#;
        let entries = parse_propfind_response(xml);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_collection);
    }

    #[test]
    fn test_parse_propfind_multiple_entries() {
        let xml = r#"<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/a.md</d:href>
    <d:propstat><d:prop></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/b.md</d:href>
    <d:propstat><d:prop></d:prop></d:propstat>
  </d:response>
</d:multistatus>"#;
        let entries = parse_propfind_response(xml);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].href, "/a.md");
        assert_eq!(entries[1].href, "/b.md");
    }
}
