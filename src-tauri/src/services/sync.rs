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
        Some("md" | "markdown" | "txt")
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
