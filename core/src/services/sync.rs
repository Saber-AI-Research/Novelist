use crate::services::webdav::{self, DavEntry, WebDavAuth};
use crate::AppError;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Serialize, Deserialize, Clone, Type, Debug)]
pub struct SyncConfig {
    pub enabled: bool,
    pub webdav_url: String,
    pub username: String,
    pub password: String,
    pub interval_minutes: u32,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            webdav_url: String::new(),
            username: String::new(),
            password: String::new(),
            interval_minutes: 30,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Type, Debug)]
pub struct SyncStatus {
    pub last_sync: Option<String>,
    pub files_uploaded: u32,
    pub files_downloaded: u32,
    pub errors: Vec<String>,
    pub in_progress: bool,
}

/// Persisted sync state: tracks last sync time and file modification times at last sync
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SyncState {
    pub last_sync_iso: Option<String>,
    /// Map of relative path -> last known modification time (as seconds since epoch)
    pub file_mod_times: HashMap<String, u64>,
}

/// Get the sync data directory for a project: ~/.novelist/sync/{project-hash}/
fn sync_dir_for_project(project_dir: &str) -> Result<PathBuf, AppError> {
    let home =
        dirs::home_dir().ok_or_else(|| AppError::Custom("Cannot find home directory".into()))?;
    let hash = blake3::hash(project_dir.as_bytes()).to_hex();
    let dir = home.join(".novelist").join("sync").join(&hash[..16]);
    Ok(dir)
}

/// Read sync config from disk
pub fn read_sync_config(project_dir: &str) -> Result<SyncConfig, AppError> {
    let dir = sync_dir_for_project(project_dir)?;
    let path = dir.join("config.json");
    if !path.exists() {
        return Ok(SyncConfig::default());
    }
    let data = std::fs::read_to_string(&path)?;
    let config: SyncConfig = serde_json::from_str(&data)?;
    Ok(config)
}

/// Save sync config to disk
pub fn save_sync_config_to_disk(project_dir: &str, config: &SyncConfig) -> Result<(), AppError> {
    let dir = sync_dir_for_project(project_dir)?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("config.json");
    let data = serde_json::to_string_pretty(config)?;
    std::fs::write(&path, data)?;
    Ok(())
}

/// Read sync state from disk
fn read_sync_state(project_dir: &str) -> Result<SyncState, AppError> {
    let dir = sync_dir_for_project(project_dir)?;
    let path = dir.join("sync-state.json");
    if !path.exists() {
        return Ok(SyncState::default());
    }
    let data = std::fs::read_to_string(&path)?;
    let state: SyncState = serde_json::from_str(&data)?;
    Ok(state)
}

/// Write sync state to disk
fn write_sync_state(project_dir: &str, state: &SyncState) -> Result<(), AppError> {
    let dir = sync_dir_for_project(project_dir)?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("sync-state.json");
    let data = serde_json::to_string_pretty(state)?;
    std::fs::write(&path, data)?;
    Ok(())
}

/// Check if a file extension is syncable
fn is_syncable(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md" | "markdown" | "txt" | "json" | "jsonl" | "csv")
    )
}

/// Collect local syncable files with their modification timestamps (seconds since epoch)
fn collect_local_files(project_dir: &Path) -> Result<HashMap<String, u64>, AppError> {
    let mut files = HashMap::new();
    for entry in walkdir::WalkDir::new(project_dir)
        .into_iter()
        .filter_entry(|e| {
            // Skip hidden directories
            let name = e.file_name().to_str().unwrap_or("");
            !name.starts_with('.')
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() || !is_syncable(path) {
            continue;
        }
        let relative = path.strip_prefix(project_dir).unwrap_or(path);
        let rel_str = relative.to_string_lossy().to_string();
        let modified = path
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        files.insert(rel_str, modified);
    }
    Ok(files)
}

/// Parse an HTTP date (RFC 2822 / RFC 7231) into seconds since epoch.
/// Handles common WebDAV date format: "Mon, 01 Jan 2024 12:00:00 GMT"
fn parse_http_date_to_epoch(date_str: &str) -> Option<u64> {
    // Simple parser for "Day, DD Mon YYYY HH:MM:SS GMT"
    let parts: Vec<&str> = date_str.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let day: u64 = parts[1].parse().ok()?;
    let month = match parts[2] {
        "Jan" => 1u64,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: u64 = parts[3].parse().ok()?;
    let time_parts: Vec<&str> = parts[4].split(':').collect();
    if time_parts.len() < 3 {
        return None;
    }
    let hour: u64 = time_parts[0].parse().ok()?;
    let min: u64 = time_parts[1].parse().ok()?;
    let sec: u64 = time_parts[2].parse().ok()?;

    // Approximate epoch calculation (not perfect for leap seconds, but fine for comparison)
    let mut days = 0u64;
    for y in 1970..year {
        days += if y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400)) {
            366
        } else {
            365
        };
    }
    let month_days = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30];
    let is_leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    for m in 1..month {
        days += month_days[m as usize];
        if m == 2 && is_leap {
            days += 1;
        }
    }
    days += day - 1;

    Some(days * 86400 + hour * 3600 + min * 60 + sec)
}

/// Build a map of relative paths to modification times from PROPFIND entries
fn build_remote_file_map(entries: &[DavEntry], base_href: &str) -> HashMap<String, u64> {
    let mut map = HashMap::new();
    let base = base_href.trim_end_matches('/');
    for entry in entries {
        if entry.is_collection {
            continue;
        }
        // Decode href and make it relative to base
        let href = &entry.href;
        let relative = if let Some(stripped) = href.strip_prefix(base) {
            stripped.trim_start_matches('/')
        } else {
            // Try URL-decoded comparison
            href.trim_start_matches('/')
        };
        if relative.is_empty() {
            continue;
        }
        // Percent-decode the relative path
        let decoded = percent_decode(relative);
        let mod_time = entry
            .last_modified
            .as_deref()
            .and_then(parse_http_date_to_epoch)
            .unwrap_or(0);
        map.insert(decoded, mod_time);
    }
    map
}

/// Simple percent-decoding for URL paths
fn percent_decode(s: &str) -> String {
    let mut result = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(val) = u8::from_str_radix(hex, 16) {
                result.push(val);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| s.to_string())
}

/// Perform an incremental sync between local project and remote WebDAV
pub async fn perform_sync(project_dir: &str) -> Result<SyncStatus, AppError> {
    let config = read_sync_config(project_dir)?;
    if !config.enabled {
        return Ok(SyncStatus {
            last_sync: None,
            files_uploaded: 0,
            files_downloaded: 0,
            errors: vec!["Sync is not enabled".into()],
            in_progress: false,
        });
    }

    let mut status = SyncStatus {
        last_sync: None,
        files_uploaded: 0,
        files_downloaded: 0,
        errors: Vec::new(),
        in_progress: true,
    };

    let auth = WebDavAuth {
        username: config.username.clone(),
        password: config.password.clone(),
    };

    let client = Client::new();
    let project_path = Path::new(project_dir);
    let project_name = project_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    let remote_base = format!("novelist/{}", project_name);

    // Ensure remote directories exist
    if let Err(e) = webdav::create_collection(&client, &config.webdav_url, "novelist", &auth).await
    {
        tracing::warn!("Failed to create novelist collection: {e}");
    }
    if let Err(e) =
        webdav::create_collection(&client, &config.webdav_url, &remote_base, &auth).await
    {
        tracing::warn!("Failed to create project collection: {e}");
    }

    // Load previous sync state
    let prev_state = read_sync_state(project_dir).unwrap_or_default();

    // Collect local files
    let local_files = collect_local_files(project_path)?;

    // List remote files
    let remote_entries =
        match webdav::list_remote(&client, &config.webdav_url, &remote_base, &auth).await {
            Ok(entries) => entries,
            Err(e) => {
                status.errors.push(format!("Failed to list remote: {e}"));
                status.in_progress = false;
                return Ok(status);
            }
        };

    // Build the base href for relative path extraction
    // The first entry in PROPFIND is usually the requested collection itself
    let base_href_guess = format!("/{}/", remote_base.trim_matches('/'));
    let remote_files = build_remote_file_map(&remote_entries, &base_href_guess);

    // Sync: compare local vs remote
    // 1. Files that exist locally
    for (rel_path, local_mod) in &local_files {
        if let Some(&remote_mod) = remote_files.get(rel_path) {
            // Both exist — compare modification times
            if *local_mod > remote_mod {
                // Local is newer -> upload
                let local_path = project_path.join(rel_path);
                let remote_path = format!("{}/{}", remote_base, rel_path);
                match webdav::upload_file(
                    &client,
                    &config.webdav_url,
                    &remote_path,
                    &local_path,
                    &auth,
                )
                .await
                {
                    Ok(()) => status.files_uploaded += 1,
                    Err(e) => status.errors.push(format!("Upload {rel_path}: {e}")),
                }
            } else if remote_mod > *local_mod {
                // Remote is newer — only download if local hasn't changed since last sync
                let prev_mod = prev_state
                    .file_mod_times
                    .get(rel_path)
                    .copied()
                    .unwrap_or(0);
                if *local_mod <= prev_mod {
                    let local_path = project_path.join(rel_path);
                    let remote_path = format!("{}/{}", remote_base, rel_path);
                    match webdav::download_file(
                        &client,
                        &config.webdav_url,
                        &remote_path,
                        &local_path,
                        &auth,
                    )
                    .await
                    {
                        Ok(()) => status.files_downloaded += 1,
                        Err(e) => status.errors.push(format!("Download {rel_path}: {e}")),
                    }
                } else {
                    tracing::info!(
                        "Conflict for {rel_path}: both local and remote modified. Keeping local."
                    );
                }
            }
        } else {
            // Local only -> upload
            // Ensure parent directories exist on remote
            if let Some(parent) = Path::new(rel_path).parent() {
                if parent != Path::new("") {
                    let parent_remote = format!("{}/{}", remote_base, parent.to_string_lossy());
                    let _ = webdav::create_collection(
                        &client,
                        &config.webdav_url,
                        &parent_remote,
                        &auth,
                    )
                    .await;
                }
            }
            let local_path = project_path.join(rel_path);
            let remote_path = format!("{}/{}", remote_base, rel_path);
            match webdav::upload_file(
                &client,
                &config.webdav_url,
                &remote_path,
                &local_path,
                &auth,
            )
            .await
            {
                Ok(()) => status.files_uploaded += 1,
                Err(e) => status.errors.push(format!("Upload {rel_path}: {e}")),
            }
        }
    }

    // 2. Files that exist only on remote -> download
    for rel_path in remote_files.keys() {
        if !local_files.contains_key(rel_path) {
            // Check if it's a syncable extension
            let p = Path::new(rel_path);
            if !is_syncable(p) {
                continue;
            }
            let local_path = project_path.join(rel_path);
            let remote_path = format!("{}/{}", remote_base, rel_path);
            match webdav::download_file(
                &client,
                &config.webdav_url,
                &remote_path,
                &local_path,
                &auth,
            )
            .await
            {
                Ok(()) => status.files_downloaded += 1,
                Err(e) => status.errors.push(format!("Download {rel_path}: {e}")),
            }
        }
    }

    // Update sync state
    let now = chrono_now_iso();
    let mut new_state = SyncState {
        last_sync_iso: Some(now.clone()),
        file_mod_times: HashMap::new(),
    };
    // Re-read local files to capture any downloaded files' new mod times
    if let Ok(updated_local) = collect_local_files(project_path) {
        new_state.file_mod_times = updated_local;
    }
    let _ = write_sync_state(project_dir, &new_state);

    status.last_sync = Some(now);
    status.in_progress = false;

    Ok(status)
}

/// Get current time as ISO 8601 string (without external chrono crate)
#[allow(clippy::manual_is_multiple_of)]
fn chrono_now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Convert epoch to ISO 8601 manually
    let secs_per_day = 86400u64;
    let mut days = now / secs_per_day;
    let day_secs = now % secs_per_day;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    let seconds = day_secs % 60;

    let mut year = 1970u64;
    loop {
        let days_in_year =
            if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) {
                366
            } else {
                365
            };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let is_leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let month_days = [
        31,
        if is_leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= month_days[month] {
        days -= month_days[month];
        month += 1;
    }
    let day = days + 1;
    month += 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_config_default() {
        let config = SyncConfig::default();
        assert!(!config.enabled);
        assert!(config.webdav_url.is_empty());
        assert!(config.username.is_empty());
        assert!(config.password.is_empty());
        assert_eq!(config.interval_minutes, 30);
    }

    #[test]
    fn test_sync_config_roundtrip() {
        let config = SyncConfig {
            enabled: true,
            webdav_url: "https://dav.example.com".to_string(),
            username: "user".to_string(),
            password: "pass".to_string(),
            interval_minutes: 15,
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: SyncConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.enabled, true);
        assert_eq!(parsed.webdav_url, "https://dav.example.com");
        assert_eq!(parsed.username, "user");
        assert_eq!(parsed.interval_minutes, 15);
    }

    #[test]
    fn test_sync_state_default() {
        let state = SyncState::default();
        assert!(state.last_sync_iso.is_none());
        assert!(state.file_mod_times.is_empty());
    }

    #[test]
    fn test_is_syncable() {
        assert!(is_syncable(Path::new("chapter.md")));
        assert!(is_syncable(Path::new("notes.markdown")));
        assert!(is_syncable(Path::new("readme.txt")));
        assert!(!is_syncable(Path::new("image.png")));
        assert!(is_syncable(Path::new("data.json")));
        assert!(is_syncable(Path::new("data.jsonl")));
        assert!(is_syncable(Path::new("data.csv")));
        assert!(!is_syncable(Path::new("script.js")));
        assert!(!is_syncable(Path::new("noext")));
    }

    #[test]
    fn test_percent_decode_no_encoding() {
        assert_eq!(percent_decode("hello/world.md"), "hello/world.md");
    }

    #[test]
    fn test_percent_decode_space() {
        assert_eq!(percent_decode("my%20file.md"), "my file.md");
    }

    #[test]
    fn test_percent_decode_chinese() {
        // %E4%BD%A0%E5%A5%BD = 你好
        assert_eq!(percent_decode("%E4%BD%A0%E5%A5%BD.md"), "你好.md");
    }

    #[test]
    fn test_percent_decode_invalid_hex() {
        // Invalid hex should pass through
        assert_eq!(percent_decode("%ZZ"), "%ZZ");
    }

    #[test]
    fn test_percent_decode_truncated() {
        // Truncated percent at end
        assert_eq!(percent_decode("test%2"), "test%2");
    }

    #[test]
    fn test_parse_http_date_valid() {
        let date = "Mon, 01 Jan 2024 12:00:00 GMT";
        let epoch = parse_http_date_to_epoch(date);
        assert!(epoch.is_some());
        // 2024-01-01 12:00:00 UTC should be > 1704067200 (2024-01-01 00:00:00)
        let val = epoch.unwrap();
        assert!(val >= 1704067200);
        assert!(val <= 1704153600); // Before 2024-01-02 00:00:00
    }

    #[test]
    fn test_parse_http_date_epoch() {
        let date = "Thu, 01 Jan 1970 00:00:00 GMT";
        let epoch = parse_http_date_to_epoch(date);
        assert_eq!(epoch, Some(0));
    }

    #[test]
    fn test_parse_http_date_invalid() {
        assert!(parse_http_date_to_epoch("invalid").is_none());
        assert!(parse_http_date_to_epoch("").is_none());
        assert!(parse_http_date_to_epoch("Mon 01").is_none());
    }

    #[test]
    fn test_build_remote_file_map_empty() {
        let map = build_remote_file_map(&[], "/novelist/project/");
        assert!(map.is_empty());
    }

    #[test]
    fn test_build_remote_file_map_skips_collections() {
        let entries = vec![DavEntry {
            href: "/novelist/project/".to_string(),
            last_modified: None,
            content_length: None,
            is_collection: true,
        }];
        let map = build_remote_file_map(&entries, "/novelist/project/");
        assert!(map.is_empty());
    }

    #[test]
    fn test_build_remote_file_map_file() {
        let entries = vec![DavEntry {
            href: "/novelist/project/chapter1.md".to_string(),
            last_modified: Some("Thu, 01 Jan 1970 00:00:00 GMT".to_string()),
            content_length: Some(100),
            is_collection: false,
        }];
        let map = build_remote_file_map(&entries, "/novelist/project");
        assert!(map.contains_key("chapter1.md"));
    }

    #[test]
    fn test_chrono_now_iso_format() {
        let iso = chrono_now_iso();
        // Should match YYYY-MM-DDTHH:MM:SSZ
        assert_eq!(iso.len(), 20);
        assert_eq!(&iso[4..5], "-");
        assert_eq!(&iso[7..8], "-");
        assert_eq!(&iso[10..11], "T");
        assert_eq!(&iso[13..14], ":");
        assert_eq!(&iso[16..17], ":");
        assert!(iso.ends_with('Z'));
    }

    #[test]
    fn test_collect_local_files() {
        // Use prefix without dot — collect_local_files skips dirs starting with '.'
        let dir = tempfile::Builder::new()
            .prefix("novelist_test_")
            .tempdir()
            .unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("chapter1.md"), "content").unwrap();
        std::fs::write(root.join("notes.txt"), "notes").unwrap();
        std::fs::write(root.join("image.png"), &[0u8; 10]).unwrap();

        let files = collect_local_files(&root).unwrap();
        assert!(files.contains_key("chapter1.md"));
        assert!(files.contains_key("notes.txt"));
        assert!(!files.contains_key("image.png"));
    }

    #[test]
    fn test_collect_local_files_skips_hidden() {
        let dir = tempfile::Builder::new()
            .prefix("novelist_test_")
            .tempdir()
            .unwrap();
        let root = dir.path().canonicalize().unwrap();
        let hidden = root.join(".git");
        std::fs::create_dir(&hidden).unwrap();
        std::fs::write(hidden.join("config.md"), "git config").unwrap();
        std::fs::write(root.join("visible.md"), "content").unwrap();

        let files = collect_local_files(&root).unwrap();
        assert!(files.contains_key("visible.md"));
        assert!(!files.keys().any(|k| k.contains(".git")));
    }

    #[test]
    fn test_sync_config_save_and_read() {
        let dir = tempfile::TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();

        let config = SyncConfig {
            enabled: true,
            webdav_url: "https://example.com/dav".to_string(),
            username: "testuser".to_string(),
            password: "testpass".to_string(),
            interval_minutes: 10,
        };

        save_sync_config_to_disk(&project, &config).unwrap();
        let loaded = read_sync_config(&project).unwrap();
        assert_eq!(loaded.enabled, true);
        assert_eq!(loaded.webdav_url, "https://example.com/dav");
        assert_eq!(loaded.username, "testuser");
        assert_eq!(loaded.interval_minutes, 10);
    }

    #[test]
    fn test_read_sync_config_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let config = read_sync_config(&project).unwrap();
        assert!(!config.enabled);
        assert!(config.webdav_url.is_empty());
    }

    #[test]
    fn test_sync_state_roundtrip() {
        let dir = tempfile::TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();

        let mut file_mod_times = HashMap::new();
        file_mod_times.insert("chapter1.md".to_string(), 1704067200u64);

        let state = SyncState {
            last_sync_iso: Some("2024-01-01T00:00:00Z".to_string()),
            file_mod_times,
        };

        write_sync_state(&project, &state).unwrap();
        let loaded = read_sync_state(&project).unwrap();
        assert_eq!(
            loaded.last_sync_iso,
            Some("2024-01-01T00:00:00Z".to_string())
        );
        assert_eq!(
            loaded.file_mod_times.get("chapter1.md"),
            Some(&1704067200u64)
        );
    }
}
