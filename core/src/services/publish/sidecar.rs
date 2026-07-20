//! Per-document Publish metadata sidecar.
//!
//! ## Layout
//!
//! ```text
//! <project>/.novelist/publish/<document_key>.json    (one per document)
//! <project>/.novelist/publish-assets/<hash>.<ext>    (shared cover assets)
//! ```
//!
//! `<document_key>` comes from `services::sidecar::document_key` and is
//! treated as opaque — no character in it is legal outside the strict
//! grammar that `sidecar_path` enforces.
//!
//! ## Schema versioning
//!
//! Sidecars carry an explicit `schema_version` integer. Reads accept
//! anything at or below `CURRENT_SCHEMA_VERSION` (older-version fields
//! not recognised now are silently dropped, matching serde's default
//! behaviour), and reject anything above so a freshly-downgraded binary
//! never silently truncates newer metadata. Writes always emit the
//! current version.
//!
//! ## Data hygiene
//!
//! `ChannelState`'s form is intentionally scoped to fields the user
//! actually types in the Publish dialog: title, tags, excerpt, slug,
//! status, destination. Auth tokens, request cursors, transient error
//! text and in-flight flags MUST NOT be added — the tests in this
//! module explicitly assert none of those substrings appear in the JSON.
//!
//! ## Cover assets
//!
//! Covers live in a shared `.novelist/publish-assets/` directory,
//! addressed by BLAKE3 content hash. The sidecar stores a small
//! `CoverRef` (hash + ext + mime + bytes) rather than embedding image
//! data. Cleanup scans every sidecar and preserves any asset referenced
//! by at least one `CoverRef`.

use crate::error::AppError;
use crate::services::publish::binding::BindingCapability;
#[cfg(test)]
use crate::services::publish::cover_assets::{asset_path, assets_dir};
use crate::services::publish::cover_assets::{parse_asset_file_name, CoverRef};
use crate::services::publish::types::ProviderRevision;
use crate::services::sidecar as sidecar_util;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as AsyncMutex;

const SIDECAR_SUBDIR: &str = "publish";
const SIDECAR_SUFFIX: &str = ".json";

/// The current on-disk schema version. Bump whenever `PublishSidecar` /
/// `ChannelState` / `FormDraft` / `RemoteIdentity` grow a field that is
/// not backwards-safe to omit.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Per-document Publish metadata. One file per document; one entry per
/// stable channel id inside.
///
/// Serialization is via `serde_json::to_vec_pretty` (through Task 1's
/// `atomic_write_json`) so sidecars are diff-friendly for the
/// rename-migration and QA test harnesses.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct PublishSidecar {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub channels: BTreeMap<String, ChannelState>,
}

impl Default for PublishSidecar {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            channels: BTreeMap::new(),
        }
    }
}

/// Per-channel state: the last saved form the user typed, the remote
/// post identity if any, and the cover reference if any.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct ChannelState {
    #[serde(default)]
    pub form: FormDraft,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<RemoteIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<CoverRef>,
}

/// The strictly-user-editable subset of the Publish dialog. Additions
/// here MUST also appear in the "no credential / no transient state"
/// tests below.
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct FormDraft {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
}

/// The identity of a post on the remote platform, once we've created or
/// bound one. `revision` is the legacy flat string retained for old
/// sidecars; `provider_revision` is the durable typed revision used by
/// current publish/update flows.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct RemoteIdentity {
    pub post_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_revision: Option<ProviderRevision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<BindingCapability>,
}

/// Absolute path of the sidecar for `(project_dir, file_path)`. Never
/// escapes `<project>/.novelist/publish/`.
pub fn publish_sidecar_path(project_dir: &Path, file_path: &Path) -> Result<PathBuf, AppError> {
    let key = sidecar_util::document_key(project_dir, file_path)?;
    sidecar_util::sidecar_path(project_dir, SIDECAR_SUBDIR, &key, SIDECAR_SUFFIX)
}

/// Read the sidecar for `(project_dir, file_path)`.
///
/// * Missing file -> `Ok(None)`.
/// * Malformed JSON -> `AppError::Json` (Task 1 preserves the on-disk
///   bytes so downstream tools can recover it).
/// * `schema_version > CURRENT_SCHEMA_VERSION` -> `AppError::InvalidInput`
///   with an explicit message. The file is left in place.
/// * Anything at or below `CURRENT_SCHEMA_VERSION` is upgraded to the
///   current shape in memory (unknown fields dropped by serde default).
pub async fn read_publish_sidecar(
    project_dir: &Path,
    file_path: &Path,
) -> Result<Option<PublishSidecar>, AppError> {
    let path = publish_sidecar_path(project_dir, file_path)?;
    let Some(storage) =
        sidecar_util::open_confined_metadata_dir(project_dir, SIDECAR_SUBDIR, false)?
    else {
        return Ok(None);
    };
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Publish sidecar has no filename".to_string()))?
        .to_string_lossy()
        .to_string();
    let raw: Option<serde_json::Value> = sidecar_util::read_json_confined(
        &storage,
        &file_name,
        sidecar_util::MAX_PUBLISH_SIDECAR_BYTES,
    )
    .await?;
    let Some(value) = raw else { return Ok(None) };
    let sidecar = migrate_value(value)?;
    validate_sidecar_contents(&sidecar)?;
    Ok(Some(sidecar))
}

/// Persist a `PublishSidecar` for `(project_dir, file_path)` atomically.
///
/// - Validates every channel id against
///   [`services::sidecar::validate_channel_id`] before touching disk.
/// - Forces `schema_version` to `CURRENT_SCHEMA_VERSION` regardless of
///   what the caller passed in.
/// - Delegates to Task 1's `atomic_write_json`, so the on-disk file is
///   fsync'd before rename and no `*.novelist-tmp` leaks on failure.
pub async fn write_publish_sidecar(
    project_dir: &Path,
    file_path: &Path,
    sidecar: &PublishSidecar,
) -> Result<(), AppError> {
    validate_sidecar_contents(sidecar)?;
    let path = publish_sidecar_path(project_dir, file_path)?;
    let to_write = PublishSidecar {
        schema_version: CURRENT_SCHEMA_VERSION,
        channels: sidecar.channels.clone(),
    };
    let storage = sidecar_util::open_confined_metadata_dir(project_dir, SIDECAR_SUBDIR, true)?
        .expect("create=true always returns a metadata directory");
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Publish sidecar has no filename".to_string()))?
        .to_string_lossy()
        .to_string();
    sidecar_util::atomic_write_json_confined(
        &storage,
        &file_name,
        &to_write,
        sidecar_util::MAX_PUBLISH_SIDECAR_BYTES,
    )
    .await
}

/// Validate every channel id AND every cover reference in a
/// `PublishSidecar`. Called on both read and write so a malicious or
/// corrupted on-disk file cannot smuggle a traversal `CoverRef` (or a
/// map key with a path separator) past the safety layer.
fn validate_sidecar_contents(sidecar: &PublishSidecar) -> Result<(), AppError> {
    for (id, state) in &sidecar.channels {
        sidecar_util::validate_channel_id(id)?;
        if let Some(cover) = &state.cover {
            cover.validate()?;
        }
    }
    Ok(())
}

static SIDECAR_WRITE_LOCKS: Lazy<StdMutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));
static COVER_ASSET_TRANSACTION_LOCKS: Lazy<StdMutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

async fn acquire_sidecar_write_lock(path: &Path) -> Arc<AsyncMutex<()>> {
    let mut guard = SIDECAR_WRITE_LOCKS
        .lock()
        .expect("publish sidecar write-lock registry poisoned");
    guard
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

pub(crate) async fn acquire_cover_asset_transaction_lock(
    project_dir: &Path,
) -> Result<Arc<AsyncMutex<()>>, AppError> {
    let project = tokio::fs::canonicalize(project_dir)
        .await
        .map_err(AppError::Io)?;
    let mut guard = COVER_ASSET_TRANSACTION_LOCKS
        .lock()
        .expect("publish cover transaction-lock registry poisoned");
    Ok(guard
        .entry(project)
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone())
}

/// Read the sidecar (defaulting to an empty one), mutate via `update`,
/// then atomic-write it back. Serializes concurrent writers on the
/// same on-disk sidecar path so two channel updates within one
/// document cannot lose each other's changes.
///
/// The serialization is a per-path async `Mutex` — atomic file rename
/// alone prevents torn JSON but not lost updates: two concurrent
/// read-modify-write cycles could each read the same starting state,
/// each mutate its own channel, and then race so the later write
/// wins with only its channel present. Holding the mutex across the
/// entire read + mutate + write window closes that window without
/// synchronizing any UNRELATED sidecars.
pub async fn update_publish_sidecar<F>(
    project_dir: &Path,
    file_path: &Path,
    update: F,
) -> Result<PublishSidecar, AppError>
where
    F: FnOnce(&mut PublishSidecar) -> Result<(), AppError>,
{
    let path = publish_sidecar_path(project_dir, file_path)?;
    let mutex = acquire_sidecar_write_lock(&path).await;
    let _guard = mutex.lock().await;
    let mut current = read_publish_sidecar(project_dir, file_path)
        .await?
        .unwrap_or_default();
    update(&mut current)?;
    write_publish_sidecar(project_dir, file_path, &current).await?;
    Ok(current)
}

/// Idempotent delete: missing sidecar is a no-op. Cover assets are NOT
/// deleted by this call — a separate `cleanup_orphan_assets` pass is
/// required so a shared asset is only removed when every sidecar has
/// released it.
pub async fn delete_publish_sidecar(project_dir: &Path, file_path: &Path) -> Result<(), AppError> {
    let path = publish_sidecar_path(project_dir, file_path)?;
    let Some(storage) =
        sidecar_util::open_confined_metadata_dir(project_dir, SIDECAR_SUBDIR, false)?
    else {
        return Ok(());
    };
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Publish sidecar has no filename".to_string()))?
        .to_string_lossy()
        .to_string();
    sidecar_util::remove_file_confined(&storage, &file_name).await
}

/// Scan every sidecar under `<project>/.novelist/publish/` and delete
/// any file in `<project>/.novelist/publish-assets/` that no sidecar
/// references. Returns the list of removed filenames (`<hash>.<ext>`).
///
/// Fail-closed contract:
/// 1. The reference-scan phase reads every `*.json` file in
///    `.novelist/publish/` uniformly — active AND conflict copies.
///    Substring classification on the filename is deliberately not
///    used: an ordinary document literally named `foo.conflict-x.md`
///    would produce a legitimate active sidecar named
///    `foo.conflict-x.md.json` which must NOT be treated as a
///    "conflict copy". Any unreadable file, malformed JSON,
///    unparseable schema version, or invalid channel id / cover ref
///    aborts cleanup before any delete happens.
/// 2. Only after the entire reference set is safely collected does
///    the deletion phase run, over a snapshot of the asset directory.
///    A single delete failure is propagated but does not roll back
///    prior deletes (the same asset would be re-deleted on the next
///    call — this is idempotent).
///
/// Files in `.novelist/publish-assets/` whose name does not match the
/// canonical `<64-hex>.<ext>` shape are never touched, protecting
/// unrelated user files a different tool may have dropped in.
///
/// I/O errors (permission denied, EIO on `read_dir` /
/// `try_exists` / `remove_file`, etc.) are propagated as
/// `AppError::Io`. Missing directories are handled explicitly and are
/// NOT converted into successful empty cleanups when the underlying
/// call errored.
pub async fn cleanup_orphan_assets(project_dir: &Path) -> Result<Vec<String>, AppError> {
    let mutex = acquire_cover_asset_transaction_lock(project_dir).await?;
    let _guard = mutex.lock().await;
    cleanup_orphan_assets_under_transaction_lock(project_dir).await
}

async fn cleanup_orphan_assets_under_transaction_lock(
    project_dir: &Path,
) -> Result<Vec<String>, AppError> {
    let referenced = collect_referenced_asset_files(project_dir).await?;
    let Some(storage) =
        sidecar_util::open_confined_metadata_dir(project_dir, "publish-assets", false)?
    else {
        return Ok(Vec::new());
    };
    let mut orphans = Vec::new();
    let entries = storage.dir.entries().map_err(AppError::Io)?;
    for entry in entries {
        let entry = entry.map_err(AppError::Io)?;
        let name = entry.file_name().to_string_lossy().to_string();
        if parse_asset_file_name(&name).is_none() {
            continue;
        }
        let file_type = entry.file_type().map_err(AppError::Io)?;
        if file_type.is_symlink() || !file_type.is_file() {
            return Err(AppError::PathNotAllowed(format!(
                "Publish asset is not a regular file: {name}"
            )));
        }
        if referenced.contains(&name) {
            continue;
        }
        orphans.push(name);
    }
    let mut removed = Vec::with_capacity(orphans.len());
    for name in orphans {
        sidecar_util::remove_file_confined(&storage, &name).await?;
        removed.push(name);
    }
    removed.sort();
    Ok(removed)
}

/// Walk `.novelist/publish/` and collect the set of asset filenames
/// currently referenced by any sidecar.
///
/// Every `*.json` file is read and fully parsed. Errors — I/O,
/// malformed JSON, non-integer / out-of-range `schema_version`,
/// invalid channel id, invalid cover ref — abort the scan with a
/// typed `AppError`. There is no per-file skip path: a corrupt
/// sidecar might have been referencing an asset before it broke, and
/// silently ignoring it would let cleanup delete data the user may
/// still be able to recover.
async fn collect_referenced_asset_files(
    project_dir: &Path,
) -> Result<std::collections::HashSet<String>, AppError> {
    let mut referenced = std::collections::HashSet::new();
    let Some(storage) =
        sidecar_util::open_confined_metadata_dir(project_dir, SIDECAR_SUBDIR, false)?
    else {
        return Ok(referenced);
    };
    let mut sidecar_names = Vec::new();
    let entries = storage.dir.entries().map_err(AppError::Io)?;
    for entry in entries {
        let entry = entry.map_err(AppError::Io)?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(SIDECAR_SUFFIX) {
            continue;
        }
        let file_type = entry.file_type().map_err(AppError::Io)?;
        if file_type.is_symlink() || !file_type.is_file() {
            return Err(AppError::PathNotAllowed(format!(
                "Publish sidecar is not a regular file: {name}"
            )));
        }
        sidecar_names.push(name);
    }
    for name in sidecar_names {
        let raw: Option<serde_json::Value> = sidecar_util::read_json_confined(
            &storage,
            &name,
            sidecar_util::MAX_PUBLISH_SIDECAR_BYTES,
        )
        .await?;
        let Some(value) = raw else { continue };
        let sidecar = migrate_value(value)?;
        validate_sidecar_contents(&sidecar)?;
        for state in sidecar.channels.values() {
            if let Some(cover) = &state.cover {
                referenced.insert(cover.file_name());
            }
        }
    }
    Ok(referenced)
}

/// Read `schema_version` from an arbitrary JSON value and dispatch to
/// the right upgrade routine.
///
/// Version-parsing rules — any deviation is an error, never a silent
/// downgrade to legacy v0:
/// - Missing key -> v0 (legacy shape, will be upgraded to current).
/// - Present JSON number that is a non-negative integer fitting in
///   `u32` -> exact version.
/// - Present JSON number that is negative, fractional, or exceeds
///   `u32::MAX` -> `InvalidInput`. No silent truncation of `u64` into
///   `u32`.
/// - Present but not a JSON number (string, bool, null, array,
///   object) -> `InvalidInput`.
/// - Value above `CURRENT_SCHEMA_VERSION` -> `InvalidInput`. Disk is
///   left untouched so a downgraded binary never truncates future
///   metadata.
fn migrate_value(value: serde_json::Value) -> Result<PublishSidecar, AppError> {
    let version = read_schema_version(&value)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(AppError::InvalidInput(format!(
            "Publish sidecar schema_version {version} is newer than supported {CURRENT_SCHEMA_VERSION}"
        )));
    }
    let sidecar: PublishSidecar = serde_json::from_value(value).map_err(AppError::Json)?;
    Ok(PublishSidecar {
        schema_version: CURRENT_SCHEMA_VERSION,
        channels: sidecar.channels,
    })
}

fn read_schema_version(value: &serde_json::Value) -> Result<u32, AppError> {
    let Some(v) = value.get("schema_version") else {
        return Ok(0);
    };
    let serde_json::Value::Number(n) = v else {
        return Err(AppError::InvalidInput(format!(
            "Publish sidecar schema_version must be a JSON number, got {v:?}"
        )));
    };
    if let Some(u) = n.as_u64() {
        if u > u32::MAX as u64 {
            return Err(AppError::InvalidInput(format!(
                "Publish sidecar schema_version {u} exceeds u32::MAX"
            )));
        }
        return Ok(u as u32);
    }
    Err(AppError::InvalidInput(format!(
        "Publish sidecar schema_version must be a non-negative integer within u32, got {n}"
    )))
}

/// A per-channel snapshot of the persisted `FormDraft`s, plus the ids
/// of any channel entries whose data could not be parsed cleanly.
///
/// This is the read shape for Task 14 (Publish form persistence): the
/// dialog restores by document + stable channel id, and a corrupt
/// entry for one channel MUST NOT hide sibling channels that are still
/// valid on disk. The corrupt ids are surfaced so the UI can render a
/// recoverable status without silently deleting or repairing the
/// source of truth.
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct PublishFormDraftsSnapshot {
    /// Channel id -> the last saved form for that channel. Only
    /// entries whose per-channel `form` object round-tripped through
    /// serde cleanly appear here.
    #[serde(default)]
    pub forms: BTreeMap<String, FormDraft>,
    /// Channel ids whose disk data was skipped because the id itself
    /// was invalid or its `form` object failed to parse. Sorted so the
    /// wire order is stable for tests / UX comparisons.
    #[serde(default)]
    pub invalid_channel_ids: Vec<String>,
}

/// Read only the per-channel form drafts for one document.
///
/// Behavior:
/// - Missing sidecar file -> empty snapshot (`Ok(default)`).
/// - Top-level JSON invalid -> `AppError::Json` (the on-disk bytes are
///   preserved so the user can recover).
/// - `schema_version` above [`CURRENT_SCHEMA_VERSION`] or invalid ->
///   `AppError::InvalidInput`.
/// - Individual channel entries that are structurally broken (invalid
///   channel id or `form` that doesn't deserialize) are recorded in
///   `invalid_channel_ids` and skipped from `forms`. Sibling channels
///   still round-trip.
///
/// This routine deliberately does NOT go through
/// [`read_publish_sidecar`], which is strict about the full sidecar
/// shape. Task 14 needs channel-level tolerance so a hand-edited or
/// forward-compatible entry does not lock the user out of restoring
/// other channels' drafts.
pub async fn read_publish_form_drafts(
    project_dir: &Path,
    file_path: &Path,
) -> Result<PublishFormDraftsSnapshot, AppError> {
    let path = publish_sidecar_path(project_dir, file_path)?;
    let Some(storage) =
        sidecar_util::open_confined_metadata_dir(project_dir, SIDECAR_SUBDIR, false)?
    else {
        return Ok(PublishFormDraftsSnapshot::default());
    };
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Publish sidecar has no filename".to_string()))?
        .to_string_lossy()
        .to_string();
    let raw: Option<Value> = sidecar_util::read_json_confined(
        &storage,
        &file_name,
        sidecar_util::MAX_PUBLISH_SIDECAR_BYTES,
    )
    .await?;
    let Some(value) = raw else {
        return Ok(PublishFormDraftsSnapshot::default());
    };
    let version = read_schema_version(&value)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(AppError::InvalidInput(format!(
            "Publish sidecar schema_version {version} is newer than supported {CURRENT_SCHEMA_VERSION}"
        )));
    }

    let mut forms: BTreeMap<String, FormDraft> = BTreeMap::new();
    let mut invalid_channel_ids: Vec<String> = Vec::new();

    match value.get("channels") {
        None => {}
        Some(Value::Object(channels)) => {
            for (channel_id, channel_value) in channels {
                if sidecar_util::validate_channel_id(channel_id).is_err() {
                    invalid_channel_ids.push(channel_id.clone());
                    continue;
                }
                match channel_value {
                    Value::Object(entry) => match entry.get("form") {
                        None => {}
                        Some(form_json) => {
                            match serde_json::from_value::<FormDraft>(form_json.clone()) {
                                Ok(form) => {
                                    forms.insert(channel_id.clone(), form);
                                }
                                Err(_) => {
                                    invalid_channel_ids.push(channel_id.clone());
                                }
                            }
                        }
                    },
                    _ => {
                        invalid_channel_ids.push(channel_id.clone());
                    }
                }
            }
        }
        Some(other) => {
            return Err(AppError::InvalidInput(format!(
                "Publish sidecar `channels` must be a JSON object, got {}",
                json_type_label(other)
            )));
        }
    }

    invalid_channel_ids.sort();
    Ok(PublishFormDraftsSnapshot {
        forms,
        invalid_channel_ids,
    })
}

fn json_type_label(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Persist a `FormDraft` for one channel while preserving that
/// channel's [`RemoteIdentity`] and [`CoverRef`] (Task 3 requirement).
///
/// - Runs through [`update_publish_sidecar`] so the write is atomic
///   and never clobbers `remote` / `cover` on the same entry.
/// - Rejects invalid channel ids up front so a call site typo never
///   creates a new channel with a bad key.
/// - Corrupt top-level sidecar -> `AppError::Json`. The frontend must
///   NOT overwrite in that case (Task 14: no silent auto-repair).
pub async fn write_publish_form_draft(
    project_dir: &Path,
    file_path: &Path,
    channel_id: &str,
    form: FormDraft,
) -> Result<(), AppError> {
    sidecar_util::validate_channel_id(channel_id)?;
    update_publish_sidecar(project_dir, file_path, |sidecar| {
        let entry = sidecar
            .channels
            .entry(channel_id.to_string())
            .or_insert_with(|| ChannelState {
                form: FormDraft::default(),
                remote: None,
                cover: None,
            });
        entry.form = form;
        Ok(())
    })
    .await
    .map(|_| ())
}

/// Convenience alias for tests + downstream: the shape a caller passes
/// when persisting a fresh cover from a Rust flow. Matches the browser
/// upload payload shape without introducing a new IPC contract here.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::publish::cover_assets::{store_cover_asset, MAX_COVER_BYTES};
    use tempfile::TempDir;

    fn png_bytes() -> Vec<u8> {
        let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(b"IHDR-1");
        v
    }

    fn other_png_bytes() -> Vec<u8> {
        let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(b"IHDR-2-DIFFERENT");
        v
    }

    fn jpeg_bytes() -> Vec<u8> {
        vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F']
    }

    fn seeded_project(name: &str) -> TempDir {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join(name)).unwrap();
        dir
    }

    fn draft(title: &str) -> FormDraft {
        FormDraft {
            title: title.to_string(),
            tags: vec!["cjk".into(), "长篇".into()],
            excerpt: Some("摘要".into()),
            slug: Some("first-chapter".into()),
            status: Some("draft".into()),
            destination: None,
        }
    }

    #[tokio::test]
    async fn round_trip_default_sidecar() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");

        let sidecar = PublishSidecar {
            schema_version: CURRENT_SCHEMA_VERSION,
            channels: BTreeMap::new(),
        };
        write_publish_sidecar(project, &file, &sidecar)
            .await
            .unwrap();
        let back = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        assert_eq!(back, sidecar);
    }

    #[tokio::test]
    async fn read_missing_returns_none() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("nope.md");
        let out = read_publish_sidecar(project, &file).await.unwrap();
        assert!(out.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn write_publish_sidecar_rejects_symlinked_publish_directory() {
        use std::os::unix::fs::symlink;

        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".novelist")).unwrap();
        symlink(
            outside.path(),
            project.path().join(".novelist").join("publish"),
        )
        .unwrap();

        let error = write_publish_sidecar(
            project.path(),
            &project.path().join("chapter.md"),
            &PublishSidecar::default(),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::PathNotAllowed(_)));
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cleanup_rejects_symlinked_asset_directory_without_deleting_outside_file() {
        use std::os::unix::fs::symlink;

        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".novelist")).unwrap();
        let outside_asset = outside.path().join(format!("{}.png", "a".repeat(64)));
        std::fs::write(&outside_asset, png_bytes()).unwrap();
        symlink(
            outside.path(),
            project.path().join(".novelist").join("publish-assets"),
        )
        .unwrap();

        let error = cleanup_orphan_assets(project.path()).await.unwrap_err();
        assert!(matches!(error, AppError::PathNotAllowed(_)));
        assert!(outside_asset.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn read_form_drafts_rejects_symlinked_publish_directory() {
        use std::os::unix::fs::symlink;

        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".novelist")).unwrap();
        symlink(
            outside.path(),
            project.path().join(".novelist").join("publish"),
        )
        .unwrap();
        let file = project.path().join("chapter.md");
        let sidecar_name = publish_sidecar_path(project.path(), &file)
            .unwrap()
            .file_name()
            .unwrap()
            .to_owned();
        std::fs::write(
            outside.path().join(sidecar_name),
            br#"{"schema_version":1,"channels":{}}"#,
        )
        .unwrap();

        let error = read_publish_form_drafts(project.path(), &file)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::PathNotAllowed(_)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn read_form_drafts_rejects_symlinked_sidecar_file() {
        use std::os::unix::fs::symlink;

        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let publish_dir = project.path().join(".novelist").join("publish");
        std::fs::create_dir_all(&publish_dir).unwrap();
        let outside_sidecar = outside.path().join("outside.json");
        std::fs::write(&outside_sidecar, br#"{"schema_version":1,"channels":{}}"#).unwrap();
        let file = project.path().join("chapter.md");
        let sidecar_path = publish_sidecar_path(project.path(), &file).unwrap();
        symlink(&outside_sidecar, &sidecar_path).unwrap();

        let error = read_publish_form_drafts(project.path(), &file)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::PathNotAllowed(_)));
    }

    #[tokio::test]
    async fn round_trips_multiple_channels() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");

        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost-personal_1".into(),
            ChannelState {
                form: draft("第一章"),
                remote: Some(RemoteIdentity {
                    post_id: "g_abc123".into(),
                    url: Some("https://blog.example.com/first-chapter".into()),
                    revision: Some("2026-07-16T04:00:00Z".into()),
                    provider_revision: Some(ProviderRevision::Ghost {
                        updated_at: "2026-07-16T04:00:00Z".into(),
                    }),
                    capability: None,
                }),
                cover: None,
            },
        );
        channels.insert(
            "wp-corporate.site".into(),
            ChannelState {
                form: FormDraft {
                    title: "First Chapter".into(),
                    tags: vec!["fiction".into()],
                    excerpt: None,
                    slug: Some("first-chapter".into()),
                    status: Some("publish".into()),
                    destination: None,
                },
                remote: None,
                cover: None,
            },
        );
        let sidecar = PublishSidecar {
            schema_version: CURRENT_SCHEMA_VERSION,
            channels,
        };
        write_publish_sidecar(project, &file, &sidecar)
            .await
            .unwrap();
        let back = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        assert_eq!(back, sidecar);
    }

    #[tokio::test]
    async fn reads_legacy_remote_identity_with_flat_revision_only() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": 1,
                "channels": {
                    "ghost1": {
                        "form": {},
                        "remote": {
                            "post_id": "g1",
                            "url": "https://example.com/a",
                            "revision": "2026-07-16T00:00:00Z"
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        let sidecar = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        let remote = sidecar.channels["ghost1"].remote.as_ref().unwrap();
        assert_eq!(remote.revision.as_deref(), Some("2026-07-16T00:00:00Z"));
        assert!(remote.provider_revision.is_none());
    }

    #[tokio::test]
    async fn round_trips_wordpress_typed_provider_revision_and_legacy_revision() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let revision = ProviderRevision::WordPress {
            modified: Some("2026-07-16T09:00:00".into()),
            modified_gmt: Some("2026-07-16T09:00:00".into()),
        };
        let mut channels = BTreeMap::new();
        channels.insert(
            "wp1".into(),
            ChannelState {
                form: FormDraft::default(),
                remote: Some(RemoteIdentity {
                    post_id: "7".into(),
                    url: Some("https://example.com/?p=7".into()),
                    revision: Some("2026-07-16T09:00:00".into()),
                    provider_revision: Some(revision.clone()),
                    capability: None,
                }),
                cover: None,
            },
        );
        let sidecar = PublishSidecar {
            schema_version: CURRENT_SCHEMA_VERSION,
            channels,
        };
        write_publish_sidecar(project, &file, &sidecar)
            .await
            .unwrap();
        let back = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        let remote = back.channels["wp1"].remote.as_ref().unwrap();
        assert_eq!(remote.revision.as_deref(), Some("2026-07-16T09:00:00"));
        assert_eq!(remote.provider_revision, Some(revision));
    }

    #[tokio::test]
    async fn round_trips_cjk_and_deeply_nested_paths() {
        let root = seeded_project("小说 项目");
        let project = root.path().join("小说 项目");
        let file = project.join("章节").join("第一章.md");

        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost-cjk_1".into(),
            ChannelState {
                form: draft("第一章"),
                remote: None,
                cover: None,
            },
        );
        let sidecar = PublishSidecar {
            schema_version: CURRENT_SCHEMA_VERSION,
            channels,
        };
        write_publish_sidecar(&project, &file, &sidecar)
            .await
            .unwrap();
        let back = read_publish_sidecar(&project, &file)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(back, sidecar);

        let path = publish_sidecar_path(&project, &file).unwrap();
        assert!(
            path.starts_with(project.join(".novelist").join("publish")),
            "sidecar path escaped .novelist/publish: {}",
            path.display()
        );
        assert!(
            path.to_string_lossy().contains("章节%2F第一章.md.json"),
            "expected percent-encoded key in path: {}",
            path.display()
        );
    }

    #[tokio::test]
    async fn round_trips_long_path_via_bounded_key() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let long_name: String = "第".to_string().repeat(120);
        let file = project.join(format!("{long_name}.md"));

        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost.long_1".into(),
            ChannelState {
                form: draft("Long title"),
                remote: None,
                cover: None,
            },
        );
        let sidecar = PublishSidecar {
            schema_version: CURRENT_SCHEMA_VERSION,
            channels,
        };
        write_publish_sidecar(project, &file, &sidecar)
            .await
            .unwrap();
        let back = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        assert_eq!(back, sidecar);

        let path = publish_sidecar_path(project, &file).unwrap();
        let component_bytes = path.file_name().unwrap().to_string_lossy().len();
        assert!(
            component_bytes <= 255,
            "bounded sidecar filename exceeds 255-byte limit: {component_bytes}"
        );
    }

    #[tokio::test]
    async fn write_rejects_publish_sidecar_over_byte_cap() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("第一章.md");
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: FormDraft {
                    title: "x".repeat(sidecar_util::MAX_PUBLISH_SIDECAR_BYTES + 1),
                    ..FormDraft::default()
                },
                remote: None,
                cover: None,
            },
        );
        let sidecar = PublishSidecar {
            schema_version: CURRENT_SCHEMA_VERSION,
            channels,
        };

        let error = write_publish_sidecar(project, &file, &sidecar)
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert!(!publish_sidecar_path(project, &file).unwrap().exists());
    }

    #[tokio::test]
    async fn write_rejects_invalid_channel_id() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");

        let mut channels = BTreeMap::new();
        channels.insert(
            "bad channel with space".into(),
            ChannelState {
                form: draft("nope"),
                remote: None,
                cover: None,
            },
        );
        let sidecar = PublishSidecar {
            schema_version: CURRENT_SCHEMA_VERSION,
            channels,
        };
        let err = write_publish_sidecar(project, &file, &sidecar)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));

        assert!(read_publish_sidecar(project, &file)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn write_normalises_schema_version() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");

        let sidecar = PublishSidecar {
            schema_version: 0,
            channels: BTreeMap::new(),
        };
        write_publish_sidecar(project, &file, &sidecar)
            .await
            .unwrap();
        let back = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        assert_eq!(back.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn read_upgrades_legacy_empty_shape() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, b"{}").await.unwrap();

        let back = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        assert_eq!(back.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(back.channels.is_empty());
    }

    #[tokio::test]
    async fn read_rejects_future_schema_version() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let future = format!(
            "{{\"schema_version\": {}, \"channels\": {{}}}}",
            CURRENT_SCHEMA_VERSION + 1
        );
        tokio::fs::write(&path, future.as_bytes()).await.unwrap();

        let err = read_publish_sidecar(project, &file).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(path.exists(), "future-version sidecar must not be deleted");
    }

    #[tokio::test]
    async fn read_preserves_malformed_sidecar_and_errors() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, b"{not: valid json").await.unwrap();

        let err = read_publish_sidecar(project, &file).await.unwrap_err();
        assert!(matches!(err, AppError::Json(_)));
        let bytes = tokio::fs::read(&path).await.unwrap();
        assert_eq!(bytes, b"{not: valid json");
    }

    #[tokio::test]
    async fn read_drops_unknown_forward_fields_silently() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let json = format!(
            "{{\"schema_version\": {}, \"channels\": {{\"ghost1\": {{ \
              \"form\": {{\"title\":\"t\",\"tags\":[]}}, \
              \"remote\": {{\"post_id\":\"g1\", \"unknown_field\":42}}, \
              \"cover\": null, \
              \"stale_transient\": true \
            }}}}}}",
            CURRENT_SCHEMA_VERSION
        );
        tokio::fs::write(&path, json.as_bytes()).await.unwrap();

        let back = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        assert_eq!(back.schema_version, CURRENT_SCHEMA_VERSION);
        let g = back.channels.get("ghost1").unwrap();
        assert_eq!(g.form.title, "t");
        assert_eq!(g.remote.as_ref().unwrap().post_id, "g1");
    }

    #[tokio::test]
    async fn write_persists_shared_cover_across_two_channels_with_dedupe() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");

        let a = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        let b = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        assert_eq!(a, b, "identical bytes must dedupe to one CoverRef");

        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("Ghost title"),
                remote: None,
                cover: Some(a.clone()),
            },
        );
        channels.insert(
            "wordpress1".into(),
            ChannelState {
                form: draft("WP title"),
                remote: None,
                cover: Some(b.clone()),
            },
        );
        let sidecar = PublishSidecar {
            schema_version: CURRENT_SCHEMA_VERSION,
            channels,
        };
        write_publish_sidecar(project, &file, &sidecar)
            .await
            .unwrap();

        let assets = tokio::fs::read_dir(assets_dir(project)).await.unwrap();
        let mut entries = assets;
        let mut count = 0usize;
        while let Some(e) = entries.next_entry().await.unwrap() {
            let n = e.file_name().to_string_lossy().to_string();
            assert!(!n.starts_with('.') || !n.ends_with(".novelist-asset-tmp"));
            count += 1;
        }
        assert_eq!(
            count, 1,
            "shared cover must dedupe to a single on-disk file"
        );
    }

    #[tokio::test]
    async fn cleanup_preserves_referenced_shared_cover() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file_a = project.join("a.md");
        let file_b = project.join("b.md");

        let cover = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        for f in [&file_a, &file_b] {
            let mut channels = BTreeMap::new();
            channels.insert(
                "ghost1".into(),
                ChannelState {
                    form: draft("shared"),
                    remote: None,
                    cover: Some(cover.clone()),
                },
            );
            let sidecar = PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            };
            write_publish_sidecar(project, f, &sidecar).await.unwrap();
        }

        delete_publish_sidecar(project, &file_a).await.unwrap();

        let removed = cleanup_orphan_assets(project).await.unwrap();
        assert!(
            removed.is_empty(),
            "shared cover deletion is unsafe: removed {removed:?}"
        );
        assert!(asset_path(project, &cover).unwrap().exists());
    }

    #[tokio::test]
    async fn cleanup_removes_orphaned_but_not_unrelated_files() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");

        let referenced = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        let orphan = store_cover_asset(project, jpeg_bytes(), Some("image/jpeg"))
            .await
            .unwrap();

        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("with cover"),
                remote: None,
                cover: Some(referenced.clone()),
            },
        );
        let sidecar = PublishSidecar {
            schema_version: CURRENT_SCHEMA_VERSION,
            channels,
        };
        write_publish_sidecar(project, &file, &sidecar)
            .await
            .unwrap();

        let stranger = assets_dir(project).join("user-notes.txt");
        tokio::fs::write(&stranger, b"leave me alone")
            .await
            .unwrap();

        let removed = cleanup_orphan_assets(project).await.unwrap();
        assert_eq!(removed, vec![orphan.file_name()]);
        assert!(asset_path(project, &referenced).unwrap().exists());
        assert!(!asset_path(project, &orphan).unwrap().exists());
        assert!(stranger.exists(), "unrelated user file must not be removed");
    }

    #[tokio::test]
    async fn cleanup_after_replacing_cover_prunes_previous_asset() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");

        let old = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("v1"),
                remote: None,
                cover: Some(old.clone()),
            },
        );
        write_publish_sidecar(
            project,
            &file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let new = store_cover_asset(project, other_png_bytes(), Some("image/png"))
            .await
            .unwrap();
        assert_ne!(old, new);
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("v2"),
                remote: None,
                cover: Some(new.clone()),
            },
        );
        write_publish_sidecar(
            project,
            &file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let removed = cleanup_orphan_assets(project).await.unwrap();
        assert_eq!(removed, vec![old.file_name()]);
        assert!(!asset_path(project, &old).unwrap().exists());
        assert!(asset_path(project, &new).unwrap().exists());
    }

    #[tokio::test]
    async fn cleanup_fails_closed_on_malformed_sidecar() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        let cover = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();

        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("has cover"),
                remote: None,
                cover: Some(cover.clone()),
            },
        );
        write_publish_sidecar(
            project,
            &file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let corrupt = project
            .join(".novelist")
            .join(SIDECAR_SUBDIR)
            .join("garbage.md.json");
        tokio::fs::write(&corrupt, b"{not a valid sidecar")
            .await
            .unwrap();

        let err = cleanup_orphan_assets(project).await.unwrap_err();
        assert!(matches!(err, AppError::Json(_)));
        assert!(asset_path(project, &cover).unwrap().exists());
    }

    #[tokio::test]
    async fn cleanup_fails_closed_on_malformed_conflict_copy() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        let cover = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("still active"),
                remote: None,
                cover: Some(cover.clone()),
            },
        );
        write_publish_sidecar(
            project,
            &file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let orphan_conflict = project
            .join(".novelist")
            .join(SIDECAR_SUBDIR)
            .join("ch.md.conflict-20260101T000000Z.json");
        tokio::fs::write(&orphan_conflict, b"not readable json")
            .await
            .unwrap();

        let err = cleanup_orphan_assets(project).await.unwrap_err();
        assert!(
            matches!(err, AppError::Json(_)),
            "cleanup must fail closed on any malformed sidecar (active OR conflict copy), got: {err}"
        );
        assert!(asset_path(project, &cover).unwrap().exists());
    }

    #[tokio::test]
    async fn serialised_json_never_contains_credentials_or_transient_state() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");

        let cover = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: FormDraft {
                    title: "Ordinary title".into(),
                    tags: vec!["ok".into()],
                    excerpt: Some("safe".into()),
                    slug: Some("s".into()),
                    status: Some("draft".into()),
                    destination: Some("dest1".into()),
                },
                remote: Some(RemoteIdentity {
                    post_id: "g1".into(),
                    url: Some("https://blog.example.com/x".into()),
                    revision: Some("2026-07-16T00:00:00Z".into()),
                    provider_revision: Some(ProviderRevision::Ghost {
                        updated_at: "2026-07-16T00:00:00Z".into(),
                    }),
                    capability: None,
                }),
                cover: Some(cover),
            },
        );
        write_publish_sidecar(
            project,
            &file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let path = publish_sidecar_path(project, &file).unwrap();
        let raw = tokio::fs::read_to_string(&path).await.unwrap();
        let lower = raw.to_ascii_lowercase();
        for banned in [
            "token",
            "password",
            "api_key",
            "apikey",
            "access_token",
            "secret",
            "credential",
            "error",
            "in_flight",
            "success_url",
            "object_url",
            "blob:",
            "data:image",
        ] {
            assert!(
                !lower.contains(banned),
                "sidecar JSON must not contain {banned:?}; got: {raw}"
            );
        }
    }

    #[tokio::test]
    async fn form_draft_omits_empty_optional_fields_from_json() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: FormDraft {
                    title: "T".into(),
                    tags: vec![],
                    excerpt: None,
                    slug: None,
                    status: None,
                    destination: None,
                },
                remote: None,
                cover: None,
            },
        );
        write_publish_sidecar(
            project,
            &file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let path = publish_sidecar_path(project, &file).unwrap();
        let raw = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(!raw.contains("\"excerpt\""));
        assert!(!raw.contains("\"slug\""));
        assert!(!raw.contains("\"status\""));
        assert!(!raw.contains("\"destination\""));
        assert!(!raw.contains("\"remote\""));
        assert!(!raw.contains("\"cover\""));
    }

    #[tokio::test]
    async fn update_publish_sidecar_creates_then_mutates() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");

        let first = update_publish_sidecar(project, &file, |s| {
            s.channels.insert(
                "ghost1".into(),
                ChannelState {
                    form: draft("initial"),
                    remote: None,
                    cover: None,
                },
            );
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(first.channels.len(), 1);

        let second = update_publish_sidecar(project, &file, |s| {
            s.channels.get_mut("ghost1").unwrap().form.title = "renamed".into();
            s.channels.insert(
                "wp1".into(),
                ChannelState {
                    form: draft("wp"),
                    remote: None,
                    cover: None,
                },
            );
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(second.channels.len(), 2);
        assert_eq!(second.channels.get("ghost1").unwrap().form.title, "renamed");
    }

    #[tokio::test]
    async fn delete_sidecar_is_idempotent_and_leaves_assets_alone() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");

        delete_publish_sidecar(project, &file).await.unwrap();

        let cover = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("t"),
                remote: None,
                cover: Some(cover.clone()),
            },
        );
        write_publish_sidecar(
            project,
            &file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        delete_publish_sidecar(project, &file).await.unwrap();
        assert!(read_publish_sidecar(project, &file)
            .await
            .unwrap()
            .is_none());
        assert!(
            asset_path(project, &cover).unwrap().exists(),
            "sidecar delete must not remove cover asset"
        );

        delete_publish_sidecar(project, &file).await.unwrap();
    }

    #[tokio::test]
    async fn oversize_cover_rejected_before_reaching_sidecar() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();

        let mut bytes = png_bytes();
        bytes.resize(MAX_COVER_BYTES + 1, 0);
        let err = store_cover_asset(project, bytes, Some("image/png"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    async fn write_raw_sidecar(project: &Path, file: &Path, body: &[u8]) -> PathBuf {
        let path = publish_sidecar_path(project, file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, body).await.unwrap();
        path
    }

    fn traversal_cover_ref() -> CoverRef {
        CoverRef {
            content_hash: "../../../etc/passwd".into(),
            extension: "png".into(),
            mime: "image/png".into(),
            bytes: 8,
        }
    }

    #[tokio::test]
    async fn read_rejects_traversal_cover_ref_smuggled_in_channel_state() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        let body = serde_json::json!({
            "schema_version": 1,
            "channels": {
                "ghost1": {
                    "form": {"title": "x", "tags": []},
                    "cover": {
                        "content_hash": "../../../etc/passwd",
                        "extension": "png",
                        "mime": "image/png",
                        "bytes": 8
                    }
                }
            }
        });
        write_raw_sidecar(project, &file, body.to_string().as_bytes()).await;

        let err = read_publish_sidecar(project, &file).await.unwrap_err();
        assert!(matches!(
            err,
            AppError::InvalidInput(_) | AppError::PathNotAllowed(_)
        ));
    }

    #[tokio::test]
    async fn read_rejects_invalid_channel_id_from_disk() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        let body = serde_json::json!({
            "schema_version": 1,
            "channels": {
                "has space": {"form": {"title": "x", "tags": []}}
            }
        });
        write_raw_sidecar(project, &file, body.to_string().as_bytes()).await;

        let err = read_publish_sidecar(project, &file).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn write_rejects_traversal_cover_ref() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");

        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("t"),
                remote: None,
                cover: Some(traversal_cover_ref()),
            },
        );
        let err = write_publish_sidecar(
            project,
            &file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(
            err,
            AppError::InvalidInput(_) | AppError::PathNotAllowed(_)
        ));
        assert!(read_publish_sidecar(project, &file)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn read_rejects_schema_version_as_string() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        write_raw_sidecar(
            project,
            &file,
            b"{\"schema_version\": \"1\", \"channels\": {}}",
        )
        .await;

        let err = read_publish_sidecar(project, &file).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn read_rejects_schema_version_as_float() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        write_raw_sidecar(
            project,
            &file,
            b"{\"schema_version\": 1.5, \"channels\": {}}",
        )
        .await;

        let err = read_publish_sidecar(project, &file).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn read_rejects_schema_version_as_negative() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        write_raw_sidecar(
            project,
            &file,
            b"{\"schema_version\": -1, \"channels\": {}}",
        )
        .await;

        let err = read_publish_sidecar(project, &file).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn read_rejects_schema_version_as_null_or_bool() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        for body in [
            b"{\"schema_version\": null, \"channels\": {}}".as_slice(),
            b"{\"schema_version\": true, \"channels\": {}}".as_slice(),
            b"{\"schema_version\": [1], \"channels\": {}}".as_slice(),
            b"{\"schema_version\": {\"v\":1}, \"channels\": {}}".as_slice(),
        ] {
            tokio::fs::remove_file(&publish_sidecar_path(project, &file).unwrap())
                .await
                .ok();
            write_raw_sidecar(project, &file, body).await;
            let err = read_publish_sidecar(project, &file).await.unwrap_err();
            assert!(
                matches!(err, AppError::InvalidInput(_)),
                "expected InvalidInput for body {:?}, got: {err:?}",
                std::str::from_utf8(body).unwrap()
            );
        }
    }

    #[tokio::test]
    async fn read_rejects_huge_schema_version_beyond_u32() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        let huge = u64::MAX;
        let body = format!("{{\"schema_version\": {huge}, \"channels\": {{}}}}");
        write_raw_sidecar(project, &file, body.as_bytes()).await;

        let err = read_publish_sidecar(project, &file).await.unwrap_err();
        assert!(
            matches!(err, AppError::InvalidInput(_)),
            "u64::MAX must not silently truncate to u32, got: {err:?}"
        );
    }

    #[tokio::test]
    async fn read_still_rejects_u32_max_when_future_version() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        let just_over = CURRENT_SCHEMA_VERSION as u64 + 1;
        let body = format!("{{\"schema_version\": {just_over}, \"channels\": {{}}}}");
        let path = write_raw_sidecar(project, &file, body.as_bytes()).await;

        let err = read_publish_sidecar(project, &file).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(path.exists(), "future-version sidecar must not be deleted");
    }

    #[tokio::test]
    async fn cleanup_fails_closed_on_malformed_active_sidecar_no_conflict_substring() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let good_file = project.join("good.md");
        let cover = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("has cover"),
                remote: None,
                cover: Some(cover.clone()),
            },
        );
        write_publish_sidecar(
            project,
            &good_file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let corrupt = project
            .join(".novelist")
            .join(SIDECAR_SUBDIR)
            .join("other.md.json");
        tokio::fs::write(&corrupt, b"not json").await.unwrap();

        let err = cleanup_orphan_assets(project).await.unwrap_err();
        assert!(matches!(err, AppError::Json(_)));
        assert!(asset_path(project, &cover).unwrap().exists());
    }

    #[tokio::test]
    async fn cleanup_treats_active_sidecar_named_conflict_uniformly_not_as_conflict_copy() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let looks_like_conflict = project.join("draft.conflict-notes.md");
        let cover = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("legitimate active doc"),
                remote: None,
                cover: Some(cover.clone()),
            },
        );
        write_publish_sidecar(
            project,
            &looks_like_conflict,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let removed = cleanup_orphan_assets(project).await.unwrap();
        assert!(
            removed.is_empty(),
            "active sidecar whose name contains .conflict- must count as a reference, got: {removed:?}"
        );
        assert!(asset_path(project, &cover).unwrap().exists());
    }

    #[tokio::test]
    async fn cleanup_scans_all_sidecars_before_deleting_any_orphan() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let good = project.join("good.md");
        let cover = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("still referencing"),
                remote: None,
                cover: Some(cover.clone()),
            },
        );
        write_publish_sidecar(
            project,
            &good,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let orphan_ref = store_cover_asset(project, jpeg_bytes(), Some("image/jpeg"))
            .await
            .unwrap();
        assert!(asset_path(project, &orphan_ref).unwrap().exists());

        let corrupt = project
            .join(".novelist")
            .join(SIDECAR_SUBDIR)
            .join("z.md.json");
        tokio::fs::write(&corrupt, b"broken").await.unwrap();

        let err = cleanup_orphan_assets(project).await.unwrap_err();
        assert!(matches!(err, AppError::Json(_)));
        assert!(
            asset_path(project, &orphan_ref).unwrap().exists(),
            "orphan must not be deleted when scan fails partway"
        );
        assert!(asset_path(project, &cover).unwrap().exists());
    }

    #[tokio::test]
    async fn read_missing_schema_version_still_upgrades_legacy_empty() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");
        write_raw_sidecar(project, &file, b"{}").await;

        let back = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        assert_eq!(back.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(back.channels.is_empty());
    }

    #[tokio::test]
    async fn cleanup_preserves_asset_referenced_by_uppercase_hash_sidecar() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch.md");

        let lower_cover = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        assert_eq!(
            lower_cover.content_hash,
            lower_cover.content_hash.to_ascii_lowercase(),
            "store_cover_asset must emit lowercase hex"
        );

        let upper_cover = CoverRef {
            content_hash: lower_cover.content_hash.to_ascii_uppercase(),
            extension: lower_cover.extension.clone(),
            mime: lower_cover.mime.clone(),
            bytes: lower_cover.bytes,
        };
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: draft("upper"),
                remote: None,
                cover: Some(upper_cover.clone()),
            },
        );
        write_publish_sidecar(
            project,
            &file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let removed = cleanup_orphan_assets(project).await.unwrap();
        assert!(
            removed.is_empty(),
            "uppercase-hash CoverRef must resolve to the canonical lowercase file, got removed={removed:?}"
        );
        assert!(asset_path(project, &lower_cover).unwrap().exists());

        let loaded =
            crate::services::publish::cover_assets::load_cover_bytes(project, &upper_cover)
                .await
                .unwrap()
                .unwrap();
        assert_eq!(loaded, png_bytes());
    }

    fn form_with_all_fields(title: &str) -> FormDraft {
        FormDraft {
            title: title.to_string(),
            tags: vec!["cjk".into(), "长篇".into()],
            excerpt: Some("摘要".into()),
            slug: Some("first-chapter".into()),
            status: Some("draft".into()),
            destination: Some("dest-a".into()),
        }
    }

    #[tokio::test]
    async fn read_form_drafts_missing_sidecar_returns_empty_snapshot() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");

        let snap = read_publish_form_drafts(project, &file).await.unwrap();
        assert!(snap.forms.is_empty());
        assert!(snap.invalid_channel_ids.is_empty());
    }

    #[tokio::test]
    async fn write_form_draft_creates_channel_and_round_trips_via_read() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");

        let form = form_with_all_fields("第一章");
        write_publish_form_draft(project, &file, "ghost1", form.clone())
            .await
            .unwrap();

        let snap = read_publish_form_drafts(project, &file).await.unwrap();
        assert!(snap.invalid_channel_ids.is_empty());
        assert_eq!(snap.forms.len(), 1);
        assert_eq!(snap.forms.get("ghost1").unwrap(), &form);
    }

    #[tokio::test]
    async fn write_form_draft_preserves_remote_and_cover_on_same_channel() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");

        let cover = store_cover_asset(project, png_bytes(), Some("image/png"))
            .await
            .unwrap();
        let mut channels = BTreeMap::new();
        channels.insert(
            "ghost1".into(),
            ChannelState {
                form: form_with_all_fields("initial title"),
                remote: Some(RemoteIdentity {
                    post_id: "g_abc".into(),
                    url: Some("https://example.com/a".into()),
                    revision: Some("2026-07-16T04:00:00Z".into()),
                    provider_revision: Some(ProviderRevision::Ghost {
                        updated_at: "2026-07-16T04:00:00Z".into(),
                    }),
                    capability: None,
                }),
                cover: Some(cover.clone()),
            },
        );
        write_publish_sidecar(
            project,
            &file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();

        let updated_form = FormDraft {
            title: "renamed title".into(),
            tags: vec!["updated".into()],
            excerpt: Some("new excerpt".into()),
            slug: Some("renamed".into()),
            status: Some("published".into()),
            destination: Some("dest-b".into()),
        };
        write_publish_form_draft(project, &file, "ghost1", updated_form.clone())
            .await
            .unwrap();

        let full = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        let entry = full.channels.get("ghost1").unwrap();
        assert_eq!(entry.form, updated_form);
        assert_eq!(
            entry.remote,
            Some(RemoteIdentity {
                post_id: "g_abc".into(),
                url: Some("https://example.com/a".into()),
                revision: Some("2026-07-16T04:00:00Z".into()),
                provider_revision: Some(ProviderRevision::Ghost {
                    updated_at: "2026-07-16T04:00:00Z".into(),
                }),
                capability: None,
            })
        );
        assert_eq!(entry.cover, Some(cover));
    }

    #[tokio::test]
    async fn write_form_draft_isolates_channels_from_each_other() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");

        let ghost_form = form_with_all_fields("第一章");
        let wp_form = FormDraft {
            title: "First Chapter".into(),
            tags: vec!["fiction".into()],
            excerpt: None,
            slug: Some("first-chapter".into()),
            status: Some("publish".into()),
            destination: None,
        };
        write_publish_form_draft(project, &file, "ghost1", ghost_form.clone())
            .await
            .unwrap();
        write_publish_form_draft(project, &file, "wordpress1", wp_form.clone())
            .await
            .unwrap();

        let snap = read_publish_form_drafts(project, &file).await.unwrap();
        assert_eq!(snap.forms.get("ghost1").unwrap(), &ghost_form);
        assert_eq!(snap.forms.get("wordpress1").unwrap(), &wp_form);
    }

    #[tokio::test]
    async fn write_form_draft_isolates_documents_from_each_other() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file_a = project.join("chapter-a.md");
        let file_b = project.join("chapter-b.md");

        let form_a = form_with_all_fields("A title");
        let form_b = FormDraft {
            title: "B title".into(),
            tags: vec!["b".into()],
            excerpt: None,
            slug: None,
            status: None,
            destination: None,
        };
        write_publish_form_draft(project, &file_a, "ghost1", form_a.clone())
            .await
            .unwrap();
        write_publish_form_draft(project, &file_b, "ghost1", form_b.clone())
            .await
            .unwrap();

        assert_eq!(
            read_publish_form_drafts(project, &file_a)
                .await
                .unwrap()
                .forms
                .get("ghost1")
                .unwrap(),
            &form_a
        );
        assert_eq!(
            read_publish_form_drafts(project, &file_b)
                .await
                .unwrap()
                .forms
                .get("ghost1")
                .unwrap(),
            &form_b
        );
    }

    #[tokio::test]
    async fn read_form_drafts_surfaces_corrupt_channel_without_hiding_siblings() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let body = format!(
            "{{\"schema_version\": {}, \"channels\": {{ \
                \"ghost1\": {{\"form\": {{\"title\": \"good\", \"tags\": []}}}}, \
                \"wordpress1\": {{\"form\": {{\"title\": 123 }} }} \
             }}}}",
            CURRENT_SCHEMA_VERSION
        );
        tokio::fs::write(&path, body.as_bytes()).await.unwrap();

        let snap = read_publish_form_drafts(project, &file).await.unwrap();
        assert_eq!(snap.invalid_channel_ids, vec!["wordpress1"]);
        assert_eq!(snap.forms.len(), 1);
        assert_eq!(snap.forms.get("ghost1").unwrap().title, "good");
    }

    #[tokio::test]
    async fn read_form_drafts_skips_invalid_channel_id_from_disk_without_hiding_siblings() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let body = format!(
            "{{\"schema_version\": {}, \"channels\": {{ \
                \"ghost1\": {{\"form\": {{\"title\": \"good\", \"tags\": []}}}}, \
                \"has space\": {{\"form\": {{\"title\": \"x\", \"tags\": []}}}} \
             }}}}",
            CURRENT_SCHEMA_VERSION
        );
        tokio::fs::write(&path, body.as_bytes()).await.unwrap();

        let snap = read_publish_form_drafts(project, &file).await.unwrap();
        assert_eq!(snap.invalid_channel_ids, vec!["has space"]);
        assert_eq!(snap.forms.len(), 1);
        assert!(snap.forms.contains_key("ghost1"));
    }

    #[tokio::test]
    async fn read_form_drafts_surfaces_top_level_json_error_and_preserves_bytes() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, b"{not json").await.unwrap();

        let err = read_publish_form_drafts(project, &file).await.unwrap_err();
        assert!(matches!(err, AppError::Json(_)));
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"{not json");
    }

    #[tokio::test]
    async fn read_form_drafts_rejects_future_schema_version() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let body = format!(
            "{{\"schema_version\": {}, \"channels\": {{}}}}",
            CURRENT_SCHEMA_VERSION + 1
        );
        tokio::fs::write(&path, body.as_bytes()).await.unwrap();

        let err = read_publish_form_drafts(project, &file).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(path.exists());
    }

    #[tokio::test]
    async fn write_form_draft_rejects_invalid_channel_id() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");

        let err = write_publish_form_draft(project, &file, "has space", form_with_all_fields("x"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(read_publish_form_drafts(project, &file)
            .await
            .unwrap()
            .forms
            .is_empty());
    }

    #[tokio::test]
    async fn write_form_draft_cjk_paths_and_content_round_trip() {
        let root = seeded_project("小说 项目");
        let project = root.path().join("小说 项目");
        let file = project.join("章节").join("第一章.md");
        let form = FormDraft {
            title: "第一章 · 序幕".into(),
            tags: vec!["剧情".into(), "开篇".into()],
            excerpt: Some("春眠不觉晓".into()),
            slug: Some("xu-mu".into()),
            status: Some("draft".into()),
            destination: Some("专栏 A".into()),
        };
        write_publish_form_draft(&project, &file, "ghost-cjk_1", form.clone())
            .await
            .unwrap();

        let snap = read_publish_form_drafts(&project, &file).await.unwrap();
        assert_eq!(snap.forms.get("ghost-cjk_1").unwrap(), &form);
    }

    #[tokio::test]
    async fn write_form_draft_overwrites_only_form_and_does_not_reset_defaults() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        write_publish_form_draft(project, &file, "ghost1", form_with_all_fields("v1"))
            .await
            .unwrap();
        let v2 = FormDraft {
            title: "v2".into(),
            tags: vec![],
            excerpt: None,
            slug: None,
            status: None,
            destination: None,
        };
        write_publish_form_draft(project, &file, "ghost1", v2.clone())
            .await
            .unwrap();
        let snap = read_publish_form_drafts(project, &file).await.unwrap();
        assert_eq!(snap.forms.get("ghost1").unwrap(), &v2);
    }

    #[tokio::test]
    async fn concurrent_writes_to_two_channels_in_one_document_do_not_lose_either() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let iterations = 25;
        let mut handles = Vec::new();
        for i in 0..iterations {
            let ghost_project = project.to_path_buf();
            let ghost_file = file.clone();
            let ghost_form = FormDraft {
                title: format!("ghost-{i}"),
                tags: vec![format!("g{i}")],
                excerpt: Some("g".into()),
                slug: Some(format!("g-{i}")),
                status: Some("draft".into()),
                destination: Some("专栏".into()),
            };
            handles.push(tokio::spawn(async move {
                write_publish_form_draft(&ghost_project, &ghost_file, "ghost1", ghost_form)
                    .await
                    .unwrap();
            }));
            let wp_project = project.to_path_buf();
            let wp_file = file.clone();
            let wp_form = FormDraft {
                title: format!("wp-{i}"),
                tags: vec![format!("w{i}")],
                excerpt: None,
                slug: Some(format!("w-{i}")),
                status: Some("publish".into()),
                destination: None,
            };
            handles.push(tokio::spawn(async move {
                write_publish_form_draft(&wp_project, &wp_file, "wordpress1", wp_form)
                    .await
                    .unwrap();
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let snap = read_publish_form_drafts(project, &file).await.unwrap();
        assert!(
            snap.forms.contains_key("ghost1"),
            "ghost1 was overwritten by concurrent wordpress1 writes"
        );
        assert!(
            snap.forms.contains_key("wordpress1"),
            "wordpress1 was overwritten by concurrent ghost1 writes"
        );
        assert!(snap.invalid_channel_ids.is_empty());

        let full = read_publish_sidecar(project, &file).await.unwrap().unwrap();
        assert!(full.channels.contains_key("ghost1"));
        assert!(full.channels.contains_key("wordpress1"));
    }

    #[tokio::test]
    async fn read_form_drafts_rejects_channels_container_that_is_not_an_object() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let body = format!(
            "{{\"schema_version\": {}, \"channels\": [1,2,3]}}",
            CURRENT_SCHEMA_VERSION
        );
        tokio::fs::write(&path, body.as_bytes()).await.unwrap();

        let err = read_publish_form_drafts(project, &file).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(path.exists());
    }

    #[tokio::test]
    async fn read_form_drafts_marks_non_object_channel_entry_as_invalid_without_dropping_siblings()
    {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let body = format!(
            "{{\"schema_version\": {}, \"channels\": {{ \
                \"ghost1\": {{\"form\": {{\"title\": \"good\", \"tags\": []}}}}, \
                \"wordpress1\": 42, \
                \"medium1\": \"not an object\" \
             }}}}",
            CURRENT_SCHEMA_VERSION
        );
        tokio::fs::write(&path, body.as_bytes()).await.unwrap();

        let snap = read_publish_form_drafts(project, &file).await.unwrap();
        assert_eq!(snap.forms.len(), 1);
        assert_eq!(snap.forms.get("ghost1").unwrap().title, "good");
        assert_eq!(snap.invalid_channel_ids, vec!["medium1", "wordpress1"]);
    }

    #[tokio::test]
    async fn read_form_drafts_allows_valid_remote_only_entry_without_form_field() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let path = publish_sidecar_path(project, &file).unwrap();
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let body = format!(
            "{{\"schema_version\": {}, \"channels\": {{ \
                \"ghost1\": {{\"form\": {{\"title\": \"has draft\", \"tags\": []}}}}, \
                \"wordpress1\": {{\"remote\": {{\"post_id\": \"wp-42\", \"url\": \"https://x/y\"}}}} \
             }}}}",
            CURRENT_SCHEMA_VERSION
        );
        tokio::fs::write(&path, body.as_bytes()).await.unwrap();

        let snap = read_publish_form_drafts(project, &file).await.unwrap();
        assert_eq!(snap.forms.len(), 1);
        assert!(snap.forms.contains_key("ghost1"));
        assert!(!snap.forms.contains_key("wordpress1"));
        assert!(
            snap.invalid_channel_ids.is_empty(),
            "remote-only entry without `form` is not invalid, got {:?}",
            snap.invalid_channel_ids
        );
    }

    #[tokio::test]
    async fn write_form_draft_round_trips_destination_field() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("ch1.md");
        let form = FormDraft {
            title: "with dest".into(),
            tags: vec![],
            excerpt: None,
            slug: None,
            status: None,
            destination: Some("medium-pub-123".into()),
        };
        write_publish_form_draft(project, &file, "medium1", form.clone())
            .await
            .unwrap();
        let snap = read_publish_form_drafts(project, &file).await.unwrap();
        assert_eq!(
            snap.forms.get("medium1").unwrap().destination.as_deref(),
            Some("medium-pub-123")
        );
    }
}
