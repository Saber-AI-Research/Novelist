use crate::error::AppError;
use crate::services::publish::sidecar::acquire_cover_asset_transaction_lock;
use crate::services::sidecar::{
    atomic_write_bytes_confined, atomic_write_json_confined, conflict_copy_path, document_key,
    file_exists_confined, legacy_sidecar_path, modified_key_confined, open_confined_metadata_dir,
    read_bytes_confined, read_json_confined, remove_file_confined, sidecar_path,
    ConfinedMetadataDir, MAX_DRAFT_NOTE_BYTES, MAX_MANAGED_NAME_SIDECAR_BYTES,
    MAX_PUBLISH_SIDECAR_BYTES,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
#[cfg(test)]
use std::collections::VecDeque;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenameMigrationStatus {
    FullSuccess,
    UserFileRenamedWithMetadataErrors,
    IdempotentRetry,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct RenameMigrationResult {
    pub status: RenameMigrationStatus,
    pub migrated: usize,
    pub conflicts: usize,
    pub errors: Vec<String>,
}

impl RenameMigrationResult {
    pub fn success(migrated: usize, conflicts: usize, idempotent_retry: bool) -> Self {
        Self {
            status: if idempotent_retry {
                RenameMigrationStatus::IdempotentRetry
            } else {
                RenameMigrationStatus::FullSuccess
            },
            migrated,
            conflicts,
            errors: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct RenameItemResult {
    pub new_path: String,
    pub migration: RenameMigrationResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocumentRenameMapping {
    pub old_path: PathBuf,
    pub new_path: PathBuf,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenameRootKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RenameJournal {
    pub schema_version: u32,
    pub root_kind: RenameRootKind,
    pub project_dir: PathBuf,
    pub old_path: PathBuf,
    pub final_path: PathBuf,
    pub mappings: Vec<DocumentRenameMapping>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameJournalReceipt {
    pub path: PathBuf,
    pub journal: RenameJournal,
}

const JOURNAL_SUBDIR: &str = "rename-migrations";
const JOURNAL_SUFFIX: &str = ".json";
const JOURNAL_SCHEMA_VERSION: u32 = 1;
const MAX_RENAME_JOURNAL_BYTES: usize = 8 * 1024 * 1024;
const RECOVERY_SUFFIX: &str = ".~recovery";

static DRAFT_TRANSACTION_LOCKS: Lazy<StdMutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

#[cfg(test)]
struct BeforeReconcileGuardPause {
    entered: tokio::sync::oneshot::Sender<()>,
    release: tokio::sync::oneshot::Receiver<()>,
}

#[cfg(test)]
static BEFORE_RECONCILE_GUARD_PAUSES: Lazy<
    StdMutex<HashMap<PathBuf, VecDeque<BeforeReconcileGuardPause>>>,
> = Lazy::new(|| StdMutex::new(HashMap::new()));

#[cfg(test)]
fn install_before_reconcile_guard_pause(
    project_dir: &Path,
) -> (
    tokio::sync::oneshot::Receiver<()>,
    tokio::sync::oneshot::Sender<()>,
) {
    let project = std::fs::canonicalize(project_dir).unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    BEFORE_RECONCILE_GUARD_PAUSES
        .lock()
        .expect("before-reconcile-guard pause registry poisoned")
        .entry(project)
        .or_default()
        .push_back(BeforeReconcileGuardPause {
            entered: entered_tx,
            release: release_rx,
        });
    (entered_rx, release_tx)
}

#[cfg(test)]
async fn pause_before_reconcile_guard_if_requested(project_dir: &Path) {
    let project = std::fs::canonicalize(project_dir).unwrap();
    let pause = {
        let mut pauses = BEFORE_RECONCILE_GUARD_PAUSES
            .lock()
            .expect("before-reconcile-guard pause registry poisoned");
        let pause = pauses.get_mut(&project).and_then(VecDeque::pop_front);
        if pauses.get(&project).is_some_and(VecDeque::is_empty) {
            pauses.remove(&project);
        }
        pause
    };
    if let Some(pause) = pause {
        let _ = pause.entered.send(());
        let _ = pause.release.await;
    }
}

#[cfg(not(test))]
async fn pause_before_reconcile_guard_if_requested(_project_dir: &Path) {}

pub(crate) async fn acquire_draft_transaction_guard(
    project_dir: &Path,
) -> Result<OwnedMutexGuard<()>, AppError> {
    let project = std::fs::canonicalize(project_dir).map_err(AppError::Io)?;
    let mutex = {
        let mut locks = DRAFT_TRANSACTION_LOCKS
            .lock()
            .expect("draft transaction-lock registry poisoned");
        locks
            .entry(project)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    Ok(mutex.lock_owned().await)
}

#[derive(Debug, Clone, Copy)]
struct SidecarKind {
    subdir: &'static str,
    suffix: &'static str,
    payload: PayloadKind,
    max_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PayloadKind {
    Bytes,
    ManagedNameJson,
}

const SIDECARS: &[SidecarKind] = &[
    SidecarKind {
        subdir: "drafts",
        suffix: ".draft.md",
        payload: PayloadKind::Bytes,
        max_bytes: MAX_DRAFT_NOTE_BYTES,
    },
    SidecarKind {
        subdir: "naming",
        suffix: ".json",
        payload: PayloadKind::ManagedNameJson,
        max_bytes: MAX_MANAGED_NAME_SIDECAR_BYTES,
    },
    SidecarKind {
        subdir: "publish",
        suffix: ".json",
        payload: PayloadKind::Bytes,
        max_bytes: MAX_PUBLISH_SIDECAR_BYTES,
    },
];

pub(crate) async fn draft_sidecar_exists(
    project_dir: &Path,
    file_path: &Path,
) -> Result<bool, AppError> {
    let kind = SIDECARS[0];
    let Some(storage) = open_confined_metadata_dir(project_dir, kind.subdir, false)? else {
        return Ok(false);
    };
    for candidate in candidate_paths(project_dir, file_path, kind)? {
        let name = metadata_file_name(&candidate.path)?;
        if !file_exists_confined(&storage, &name).await? {
            continue;
        }
        if candidate.legacy
            && draft_storage_key_has_live_owner(project_dir, Some(file_path), &candidate.key)?
        {
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
pub async fn migrate_rename_sidecars(
    project_dir: &Path,
    mappings: &[DocumentRenameMapping],
    idempotent_retry: bool,
) -> RenameMigrationResult {
    migrate_rename_sidecars_inner(project_dir, mappings, idempotent_retry, false).await
}

pub(crate) async fn migrate_rename_sidecars_guarded(
    project_dir: &Path,
    mappings: &[DocumentRenameMapping],
    idempotent_retry: bool,
) -> RenameMigrationResult {
    migrate_rename_sidecars_inner(project_dir, mappings, idempotent_retry, true).await
}

async fn migrate_rename_sidecars_inner(
    project_dir: &Path,
    mappings: &[DocumentRenameMapping],
    idempotent_retry: bool,
    draft_guarded: bool,
) -> RenameMigrationResult {
    let mut migrated = 0usize;
    let mut conflicts = 0usize;
    let mut errors = Vec::new();

    for mapping in mappings {
        for kind in SIDECARS {
            let migration = match kind.subdir {
                "drafts" if draft_guarded => migrate_draft_kind(project_dir, mapping, *kind).await,
                "drafts" => match acquire_draft_transaction_guard(project_dir).await {
                    Ok(_guard) => migrate_draft_kind(project_dir, mapping, *kind).await,
                    Err(error) => Err(error),
                },
                "publish" => match acquire_cover_asset_transaction_lock(project_dir).await {
                    Ok(mutex) => {
                        let _guard = mutex.lock().await;
                        migrate_publish_kind(project_dir, mapping, *kind).await
                    }
                    Err(error) => Err(error),
                },
                _ => migrate_one_kind(project_dir, mapping, *kind).await,
            };
            match migration {
                Ok(outcome) => {
                    migrated += outcome.migrated;
                    conflicts += outcome.conflicts;
                }
                Err(err) => errors.push(format!(
                    "kind={} old_path={} new_path={} error={}",
                    kind.subdir,
                    mapping.old_path.display(),
                    mapping.new_path.display(),
                    err
                )),
            }
        }
    }

    if errors.is_empty() {
        RenameMigrationResult::success(migrated, conflicts, idempotent_retry)
    } else {
        RenameMigrationResult {
            status: RenameMigrationStatus::UserFileRenamedWithMetadataErrors,
            migrated,
            conflicts,
            errors,
        }
    }
}

fn confined_journal_names(storage: &ConfinedMetadataDir) -> Result<Vec<String>, AppError> {
    let mut names = Vec::new();
    for entry in storage.dir.entries().map_err(AppError::Io)? {
        let entry = entry.map_err(AppError::Io)?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(JOURNAL_SUFFIX) {
            continue;
        }
        let file_type = entry.file_type().map_err(AppError::Io)?;
        if file_type.is_symlink() || !file_type.is_file() {
            return Err(AppError::PathNotAllowed(format!(
                "Rename journal is not a regular file: {name}"
            )));
        }
        names.push(name);
    }
    names.sort();
    Ok(names)
}
pub(crate) async fn ensure_draft_key_not_reserved(
    project_dir: &Path,
    file_path: &Path,
    storage_key: &str,
) -> Result<(), AppError> {
    let Some(storage) = open_confined_metadata_dir(project_dir, JOURNAL_SUBDIR, false)? else {
        return Ok(());
    };
    let requested = PathBuf::from(file_path.to_string_lossy().replace('\\', "/"));
    let requested_legacy = legacy_draft_key(project_dir, file_path);
    for name in confined_journal_names(&storage)? {
        let Some(journal): Option<RenameJournal> =
            read_json_confined(&storage, &name, MAX_RENAME_JOURNAL_BYTES).await?
        else {
            continue;
        };
        if journal.schema_version != JOURNAL_SCHEMA_VERSION || journal.project_dir != project_dir {
            return Err(AppError::InvalidInput(format!(
                "invalid pending rename journal: {}",
                storage.absolute.join(&name).display()
            )));
        }
        validate_journal_paths(
            project_dir,
            &journal.old_path,
            &journal.final_path,
            &journal.mappings,
            journal.root_kind,
        )?;
        for mapping in &journal.mappings {
            for reserved_path in [mapping.old_path.clone(), recovery_path(&mapping.old_path)] {
                let normalized = PathBuf::from(reserved_path.to_string_lossy().replace('\\', "/"));
                let canonical = document_key(project_dir, &reserved_path)?;
                let legacy = legacy_draft_key(project_dir, &reserved_path);
                let requested_legacy_reserved = requested_legacy
                    .as_deref()
                    .is_some_and(|key| key == canonical || legacy.as_deref() == Some(key));
                if normalized == requested
                    || canonical == storage_key
                    || legacy.as_deref() == Some(storage_key)
                    || requested_legacy_reserved
                {
                    return Err(AppError::InvalidInput(format!(
                        "Draft key is reserved by pending rename: {}",
                        storage_key
                    )));
                }
            }
        }
    }
    Ok(())
}
pub(crate) async fn reconcile_draft_sidecar(
    project_dir: &Path,
    file_path: &Path,
) -> Result<(), AppError> {
    let kind = SIDECARS[0];
    let Some(storage) = open_confined_metadata_dir(project_dir, kind.subdir, false)? else {
        return Ok(());
    };
    migrate_confined_kind_logical(&storage, project_dir, file_path, file_path, kind).await?;
    Ok(())
}

pub(crate) async fn reconcile_project_draft_sidecars(project_dir: &Path) -> Result<(), AppError> {
    pause_before_reconcile_guard_if_requested(project_dir).await;
    let _guard = acquire_draft_transaction_guard(project_dir).await?;
    if let Some(storage) = open_confined_metadata_dir(project_dir, JOURNAL_SUBDIR, false)? {
        if !confined_journal_names(&storage)?.is_empty() {
            return Ok(());
        }
    }

    let kind = SIDECARS[0];
    let Some(storage) = open_confined_metadata_dir(project_dir, kind.subdir, false)? else {
        return Ok(());
    };
    let mut files = Vec::new();
    collect_live_project_files(project_dir, project_dir, &mut files)?;
    for file in files {
        for logical_path in [file.clone(), recovery_path(&file)] {
            migrate_confined_kind_logical(
                &storage,
                project_dir,
                &logical_path,
                &logical_path,
                kind,
            )
            .await?;
        }
    }
    Ok(())
}

fn collect_live_project_files(
    project_dir: &Path,
    dir: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || path.file_name().is_some_and(|name| name == ".novelist") {
            continue;
        }
        if file_type.is_dir() {
            collect_live_project_files(project_dir, &path, files)?;
        } else if file_type.is_file() && path.starts_with(project_dir) {
            files.push(path);
        }
    }
    Ok(())
}

async fn migrate_draft_kind(
    project_dir: &Path,
    mapping: &DocumentRenameMapping,
    kind: SidecarKind,
) -> Result<MigrationOutcome, AppError> {
    let mut outcome = MigrationOutcome::default();
    let Some(storage) = open_confined_metadata_dir(project_dir, kind.subdir, false)? else {
        return Ok(outcome);
    };
    let logical_mappings = [
        DocumentRenameMapping {
            old_path: mapping.old_path.clone(),
            new_path: mapping.new_path.clone(),
        },
        DocumentRenameMapping {
            old_path: recovery_path(&mapping.old_path),
            new_path: recovery_path(&mapping.new_path),
        },
    ];

    for logical in logical_mappings {
        let logical_outcome = migrate_confined_kind_logical(
            &storage,
            project_dir,
            &logical.old_path,
            &logical.new_path,
            kind,
        )
        .await?;
        outcome.migrated += logical_outcome.migrated;
        outcome.conflicts += logical_outcome.conflicts;
    }
    Ok(outcome)
}

struct ConfinedEntry {
    rank: usize,
    path: PathBuf,
    name: String,
    bytes: Vec<u8>,
    modified: (u64, u32),
    source: bool,
}

async fn migrate_confined_kind_logical(
    storage: &ConfinedMetadataDir,
    project_dir: &Path,
    old_path: &Path,
    new_path: &Path,
    kind: SidecarKind,
) -> Result<MigrationOutcome, AppError> {
    let mut outcome = MigrationOutcome::default();
    let new_key = document_key(project_dir, new_path)?;
    let dest = sidecar_path(project_dir, kind.subdir, &new_key, kind.suffix)?;
    let dest_name = metadata_file_name(&dest)?;
    let mut entries = Vec::new();

    if let Some(bytes) = read_bytes_confined(storage, &dest_name, kind.max_bytes).await? {
        let modified = modified_key_confined(storage, &dest_name)
            .await?
            .ok_or_else(|| AppError::FileNotFound(dest.display().to_string()))?;
        entries.push(ConfinedEntry {
            rank: 0,
            path: dest.clone(),
            name: dest_name.clone(),
            bytes,
            modified,
            source: false,
        });
    }

    for (rank, candidate) in candidate_paths(project_dir, old_path, kind)?
        .into_iter()
        .enumerate()
    {
        let source = candidate.path;
        if source == dest {
            continue;
        }
        let name = metadata_file_name(&source)?;
        let Some(bytes) = read_bytes_confined(storage, &name, kind.max_bytes).await? else {
            continue;
        };
        if candidate.legacy
            && draft_storage_key_has_live_owner(project_dir, Some(old_path), &candidate.key)?
        {
            let reference = entries
                .first()
                .map(|entry| entry.bytes.as_slice())
                .unwrap_or(b"ambiguous-legacy-owner");
            write_confined_conflict_once(
                storage,
                &dest,
                &bytes,
                &source,
                reference,
                kind.max_bytes,
            )
            .await?;
            outcome.conflicts += 1;
            if old_path != new_path {
                return Err(AppError::Custom(format!(
                    "ambiguous legacy draft retained: source={} destination={}",
                    source.display(),
                    dest.display()
                )));
            }
            continue;
        }
        let modified = modified_key_confined(storage, &name)
            .await?
            .ok_or_else(|| AppError::FileNotFound(source.display().to_string()))?;
        entries.push(ConfinedEntry {
            rank: rank + 1,
            path: source,
            name,
            bytes,
            modified,
            source: true,
        });
    }

    if !entries.iter().any(|entry| entry.source) {
        return Ok(outcome);
    }

    let destination_snapshot = entries.iter().find(|entry| !entry.source);
    match (
        destination_snapshot,
        read_bytes_confined(storage, &dest_name, kind.max_bytes).await?,
    ) {
        (Some(snapshot), Some(current)) if current == snapshot.bytes => {}
        (None, None) => {}
        _ => {
            return Err(AppError::Custom(format!(
                "draft destination changed during migration: {}",
                dest.display()
            )))
        }
    }
    for source in entries.iter().filter(|entry| entry.source) {
        if read_bytes_confined(storage, &source.name, kind.max_bytes)
            .await?
            .as_deref()
            != Some(source.bytes.as_slice())
        {
            return Err(AppError::Custom(format!(
                "draft source changed during migration: {}",
                source.path.display()
            )));
        }
    }

    entries.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| left.rank.cmp(&right.rank))
    });
    let winner = &entries[0];

    for loser in entries.iter().skip(1) {
        if sidecar_bytes_equivalent(&winner.bytes, &loser.bytes, kind.payload) {
            continue;
        }
        let marker_source = if loser.source {
            &loser.path
        } else {
            &winner.path
        };
        write_confined_conflict_once(
            storage,
            &dest,
            &loser.bytes,
            marker_source,
            &winner.bytes,
            kind.max_bytes,
        )
        .await?;
        outcome.conflicts += 1;
    }

    let destination_matches = entries
        .iter()
        .find(|entry| !entry.source)
        .is_some_and(|entry| sidecar_bytes_equivalent(&entry.bytes, &winner.bytes, kind.payload));
    if !destination_matches {
        atomic_write_bytes_confined(storage, &dest_name, &winner.bytes).await?;
    }
    for source in entries.iter().skip(1).filter(|entry| entry.source) {
        if read_bytes_confined(storage, &source.name, kind.max_bytes)
            .await?
            .as_deref()
            != Some(source.bytes.as_slice())
        {
            return Err(AppError::Custom(format!(
                "draft source changed before cleanup: {}",
                source.path.display()
            )));
        }
        remove_file_confined(storage, &source.name).await?;
        outcome.migrated += 1;
    }
    if winner.source {
        if read_bytes_confined(storage, &winner.name, kind.max_bytes)
            .await?
            .as_deref()
            != Some(winner.bytes.as_slice())
        {
            return Err(AppError::Custom(format!(
                "draft winner changed before cleanup: {}",
                winner.path.display()
            )));
        }
        remove_file_confined(storage, &winner.name).await?;
        outcome.migrated += 1;
    }
    Ok(outcome)
}

async fn migrate_publish_kind(
    project_dir: &Path,
    mapping: &DocumentRenameMapping,
    kind: SidecarKind,
) -> Result<MigrationOutcome, AppError> {
    let mut outcome = MigrationOutcome::default();
    let Some(storage) = open_confined_metadata_dir(project_dir, kind.subdir, false)? else {
        return Ok(outcome);
    };
    let new_key = document_key(project_dir, &mapping.new_path)?;
    let dest = sidecar_path(project_dir, kind.subdir, &new_key, kind.suffix)?;
    let dest_name = metadata_file_name(&dest)?;
    for candidate in candidate_paths(project_dir, &mapping.old_path, kind)? {
        let source = candidate.path;
        if source == dest {
            continue;
        }
        let source_name = metadata_file_name(&source)?;
        let Some(source_bytes) =
            read_bytes_confined(&storage, &source_name, kind.max_bytes).await?
        else {
            continue;
        };
        let action = merge_confined_sidecar_bytes(
            &storage,
            &source,
            &source_name,
            &dest,
            &dest_name,
            &source_bytes,
            kind,
        )
        .await?;
        outcome.migrated += usize::from(action.migrated);
        outcome.conflicts += usize::from(action.conflicted);
    }
    Ok(outcome)
}

fn metadata_file_name(path: &Path) -> Result<String, AppError> {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| {
            AppError::InvalidInput(format!("Metadata path has no filename: {}", path.display()))
        })
}

async fn merge_confined_sidecar_bytes(
    storage: &ConfinedMetadataDir,
    source: &Path,
    source_name: &str,
    dest: &Path,
    dest_name: &str,
    source_bytes: &[u8],
    kind: SidecarKind,
) -> Result<MergeAction, AppError> {
    let Some(dest_bytes) = read_bytes_confined(storage, dest_name, kind.max_bytes).await? else {
        atomic_write_bytes_confined(storage, dest_name, source_bytes).await?;
        remove_file_confined(storage, source_name).await?;
        return Ok(MergeAction {
            migrated: true,
            conflicted: false,
        });
    };

    if sidecar_bytes_equivalent(&dest_bytes, source_bytes, kind.payload) {
        remove_file_confined(storage, source_name).await?;
        return Ok(MergeAction {
            migrated: true,
            conflicted: false,
        });
    }

    let source_modified = modified_key_confined(storage, source_name)
        .await?
        .ok_or_else(|| AppError::FileNotFound(source.display().to_string()))?;
    let dest_modified = modified_key_confined(storage, dest_name)
        .await?
        .ok_or_else(|| AppError::FileNotFound(dest.display().to_string()))?;
    let source_newer = source_modified > dest_modified;
    if source_newer {
        write_confined_conflict_once(
            storage,
            dest,
            &dest_bytes,
            source,
            source_bytes,
            kind.max_bytes,
        )
        .await?;
        atomic_write_bytes_confined(storage, dest_name, source_bytes).await?;
        remove_file_confined(storage, source_name).await?;
    } else {
        write_confined_conflict_once(
            storage,
            dest,
            source_bytes,
            source,
            &dest_bytes,
            kind.max_bytes,
        )
        .await?;
        remove_file_confined(storage, source_name).await?;
    }
    Ok(MergeAction {
        migrated: true,
        conflicted: true,
    })
}

async fn write_confined_conflict_once(
    storage: &ConfinedMetadataDir,
    dest: &Path,
    older_bytes: &[u8],
    source: &Path,
    newer_bytes: &[u8],
    max_bytes: usize,
) -> Result<(), AppError> {
    let marker = conflict_marker(dest, source, older_bytes, newer_bytes);
    let conflict = conflict_copy_path(dest, &marker)?;
    let conflict_name = metadata_file_name(&conflict)?;
    match read_bytes_confined(storage, &conflict_name, max_bytes).await? {
        Some(existing) if existing == older_bytes => return Ok(()),
        Some(_) => {
            return Err(AppError::Custom(format!(
                "conflict copy already exists with different bytes: kind=metadata source={} conflict={}",
                source.display(),
                conflict.display()
            )))
        }
        None => {}
    }
    atomic_write_bytes_confined(storage, &conflict_name, older_bytes).await
}

#[derive(Default)]
struct MigrationOutcome {
    migrated: usize,
    conflicts: usize,
}

async fn migrate_one_kind(
    project_dir: &Path,
    mapping: &DocumentRenameMapping,
    kind: SidecarKind,
) -> Result<MigrationOutcome, AppError> {
    let mut outcome = MigrationOutcome::default();
    let Some(storage) = open_confined_metadata_dir(project_dir, kind.subdir, false)? else {
        return Ok(outcome);
    };

    let new_key = document_key(project_dir, &mapping.new_path)?;
    let dest = sidecar_path(project_dir, kind.subdir, &new_key, kind.suffix)?;
    let dest_name = metadata_file_name(&dest)?;
    for candidate in candidate_paths(project_dir, &mapping.old_path, kind)? {
        let source = candidate.path;
        if source == dest {
            continue;
        }
        let source_name = metadata_file_name(&source)?;
        let Some(raw) = read_bytes_confined(&storage, &source_name, kind.max_bytes).await? else {
            continue;
        };
        let bytes = match kind.payload {
            PayloadKind::Bytes => raw,
            PayloadKind::ManagedNameJson => migrate_managed_name_payload(&raw, &new_key)?,
        };
        if bytes.len() > kind.max_bytes {
            return Err(AppError::InvalidInput(format!(
                "Migrated {} sidecar is {} bytes; limit is {}",
                kind.subdir,
                bytes.len(),
                kind.max_bytes
            )));
        }
        let action = merge_confined_sidecar_bytes(
            &storage,
            &source,
            &source_name,
            &dest,
            &dest_name,
            &bytes,
            kind,
        )
        .await?;
        outcome.migrated += usize::from(action.migrated);
        outcome.conflicts += usize::from(action.conflicted);
    }

    Ok(outcome)
}
fn recovery_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}{}", path.display(), RECOVERY_SUFFIX))
}

#[derive(Default)]
struct MergeAction {
    migrated: bool,
    conflicted: bool,
}

fn sidecar_bytes_equivalent(dest_bytes: &[u8], source_bytes: &[u8], payload: PayloadKind) -> bool {
    if dest_bytes == source_bytes {
        return true;
    }
    if payload != PayloadKind::ManagedNameJson {
        return false;
    }
    let Ok(dest_value) = serde_json::from_slice::<serde_json::Value>(dest_bytes) else {
        return false;
    };
    let Ok(source_value) = serde_json::from_slice::<serde_json::Value>(source_bytes) else {
        return false;
    };
    dest_value == source_value
}

fn conflict_marker(dest: &Path, source: &Path, older_bytes: &[u8], newer_bytes: &[u8]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(dest.to_string_lossy().as_bytes());
    hasher.update(b"\0");
    hasher.update(source.to_string_lossy().as_bytes());
    hasher.update(b"\0");
    hasher.update(older_bytes);
    hasher.update(b"\0");
    hasher.update(newer_bytes);
    hasher.finalize().to_hex().as_str()[..16].to_string()
}

#[cfg(test)]
pub(crate) fn test_conflict_marker(
    dest: &Path,
    source: &Path,
    older_bytes: &[u8],
    newer_bytes: &[u8],
) -> String {
    conflict_marker(dest, source, older_bytes, newer_bytes)
}

fn migrate_managed_name_payload(raw: &[u8], new_key: &str) -> Result<Vec<u8>, AppError> {
    let mut value: serde_json::Value = serde_json::from_slice(raw)?;
    if let Some(obj) = value.as_object_mut() {
        if obj.get("documentKey").is_some() {
            obj.insert(
                "documentKey".to_string(),
                serde_json::Value::String(new_key.to_string()),
            );
        }
    }
    Ok(serde_json::to_vec_pretty(&value)?)
}

pub async fn write_rename_journal(
    project_dir: &Path,
    old_path: &Path,
    final_path: &Path,
    mappings: &[DocumentRenameMapping],
) -> Result<RenameJournalReceipt, AppError> {
    let root_kind = derive_root_kind(old_path)?;
    validate_journal_paths(project_dir, old_path, final_path, mappings, root_kind)?;
    let journal = RenameJournal {
        schema_version: JOURNAL_SCHEMA_VERSION,
        root_kind,
        project_dir: project_dir.to_path_buf(),
        old_path: old_path.to_path_buf(),
        final_path: final_path.to_path_buf(),
        mappings: mappings.to_vec(),
    };
    let path = journal_path(project_dir, old_path, final_path)?;
    let storage = open_confined_metadata_dir(project_dir, JOURNAL_SUBDIR, true)?
        .expect("create=true always returns a metadata directory");
    atomic_write_json_confined(
        &storage,
        &metadata_file_name(&path)?,
        &journal,
        MAX_RENAME_JOURNAL_BYTES,
    )
    .await?;
    Ok(RenameJournalReceipt { path, journal })
}
pub async fn load_matching_journal(
    project_dir: &Path,
    old_path: &Path,
    final_path: &Path,
) -> Result<Option<RenameJournalReceipt>, AppError> {
    let path = journal_path(project_dir, old_path, final_path)?;
    let Some(storage) = open_confined_metadata_dir(project_dir, JOURNAL_SUBDIR, false)? else {
        return Ok(None);
    };
    let Some(journal): Option<RenameJournal> = read_json_confined(
        &storage,
        &metadata_file_name(&path)?,
        MAX_RENAME_JOURNAL_BYTES,
    )
    .await?
    else {
        return Ok(None);
    };
    if journal.schema_version != JOURNAL_SCHEMA_VERSION
        || journal.project_dir != project_dir
        || journal.old_path != old_path
        || journal.final_path != final_path
    {
        return Err(AppError::InvalidInput(format!(
            "rename journal does not match requested rename: old={} final={}",
            old_path.display(),
            final_path.display()
        )));
    }
    validate_journal_paths(
        project_dir,
        old_path,
        final_path,
        &journal.mappings,
        journal.root_kind,
    )?;
    Ok(Some(RenameJournalReceipt { path, journal }))
}

pub(crate) async fn load_pending_move_journal(
    project_dir: &Path,
    old_path: &Path,
    target_dir: &Path,
) -> Result<Option<RenameJournalReceipt>, AppError> {
    let Some(storage) = open_confined_metadata_dir(project_dir, JOURNAL_SUBDIR, false)? else {
        return Ok(None);
    };
    let mut matched = None;
    for name in confined_journal_names(&storage)? {
        let Some(journal): Option<RenameJournal> =
            read_json_confined(&storage, &name, MAX_RENAME_JOURNAL_BYTES).await?
        else {
            continue;
        };
        if journal.schema_version != JOURNAL_SCHEMA_VERSION || journal.project_dir != project_dir {
            return Err(AppError::InvalidInput(format!(
                "invalid pending rename journal: {}",
                storage.absolute.join(&name).display()
            )));
        }
        validate_journal_paths(
            project_dir,
            &journal.old_path,
            &journal.final_path,
            &journal.mappings,
            journal.root_kind,
        )?;
        if journal.old_path != old_path || journal.final_path.parent() != Some(target_dir) {
            continue;
        }
        if matched.is_some() {
            return Err(AppError::InvalidInput(format!(
                "multiple pending move journals match source={} target={}",
                old_path.display(),
                target_dir.display()
            )));
        }
        matched = Some(RenameJournalReceipt {
            path: storage.absolute.join(&name),
            journal,
        });
    }
    Ok(matched)
}

pub async fn remove_rename_journal(path: &Path) -> Result<(), AppError> {
    let project_dir = journal_project_dir(path)?;
    let Some(storage) = open_confined_metadata_dir(&project_dir, JOURNAL_SUBDIR, false)? else {
        return Ok(());
    };
    remove_file_confined(&storage, &metadata_file_name(path)?).await
}
fn journal_path(
    project_dir: &Path,
    old_path: &Path,
    final_path: &Path,
) -> Result<PathBuf, AppError> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(project_dir.to_string_lossy().as_bytes());
    hasher.update(&[0]);
    hasher.update(old_path.to_string_lossy().as_bytes());
    hasher.update(&[0]);
    hasher.update(final_path.to_string_lossy().as_bytes());
    let key = hasher.finalize().to_hex().as_str()[..32].to_string();
    sidecar_path(project_dir, JOURNAL_SUBDIR, &key, JOURNAL_SUFFIX)
}
fn journal_project_dir(path: &Path) -> Result<PathBuf, AppError> {
    let journal_dir = path.parent().ok_or_else(|| {
        AppError::InvalidInput(format!("Rename journal has no parent: {}", path.display()))
    })?;
    if journal_dir.file_name() != Some(std::ffi::OsStr::new(JOURNAL_SUBDIR)) {
        return Err(AppError::PathNotAllowed(format!(
            "Rename journal is outside {JOURNAL_SUBDIR}: {}",
            path.display()
        )));
    }
    let novelist_dir = journal_dir.parent().ok_or_else(|| {
        AppError::InvalidInput(format!(
            "Rename journal has no .novelist parent: {}",
            path.display()
        ))
    })?;
    if novelist_dir.file_name() != Some(std::ffi::OsStr::new(".novelist")) {
        return Err(AppError::PathNotAllowed(format!(
            "Rename journal is outside .novelist: {}",
            path.display()
        )));
    }
    let project_dir = novelist_dir.parent().ok_or_else(|| {
        AppError::InvalidInput(format!(
            "Rename journal has no project parent: {}",
            path.display()
        ))
    })?;
    let project_dir = if project_dir.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        project_dir.to_path_buf()
    };
    let expected = project_dir
        .join(".novelist")
        .join(JOURNAL_SUBDIR)
        .join(metadata_file_name(path)?);
    if expected != path {
        return Err(AppError::PathNotAllowed(format!(
            "Rename journal path is not canonical for its project: {}",
            path.display()
        )));
    }
    Ok(project_dir)
}

fn validate_journal_paths(
    project_dir: &Path,
    old_path: &Path,
    final_path: &Path,
    mappings: &[DocumentRenameMapping],
    root_kind: RenameRootKind,
) -> Result<(), AppError> {
    for path in [old_path, final_path] {
        if !path.starts_with(project_dir) {
            return Err(AppError::PathNotAllowed(format!(
                "rename journal path outside project: {}",
                path.display()
            )));
        }
    }
    for mapping in mappings {
        if !mapping.old_path.starts_with(project_dir) || !mapping.new_path.starts_with(project_dir)
        {
            return Err(AppError::PathNotAllowed(format!(
                "rename journal mapping outside project: old={} new={}",
                mapping.old_path.display(),
                mapping.new_path.display()
            )));
        }
    }

    match root_kind {
        RenameRootKind::File => validate_file_journal_paths(old_path, final_path, mappings),
        RenameRootKind::Directory => {
            validate_directory_journal_paths(old_path, final_path, mappings)
        }
    }
}

fn derive_root_kind(old_path: &Path) -> Result<RenameRootKind, AppError> {
    if old_path.is_dir() {
        Ok(RenameRootKind::Directory)
    } else if old_path.is_file() {
        Ok(RenameRootKind::File)
    } else {
        Err(AppError::FileNotFound(old_path.display().to_string()))
    }
}

fn validate_unique_mappings(mappings: &[DocumentRenameMapping]) -> Result<(), AppError> {
    let mut seen_old = BTreeSet::new();
    let mut seen_new = BTreeSet::new();
    for mapping in mappings {
        if !seen_old.insert(mapping.old_path.clone()) || !seen_new.insert(mapping.new_path.clone())
        {
            return Err(AppError::InvalidInput(format!(
                "rename journal contains duplicate mapping: old={} new={}",
                mapping.old_path.display(),
                mapping.new_path.display()
            )));
        }
    }
    Ok(())
}

fn validate_file_journal_paths(
    old_path: &Path,
    final_path: &Path,
    mappings: &[DocumentRenameMapping],
) -> Result<(), AppError> {
    validate_unique_mappings(mappings)?;
    if mappings.len() != 1 || mappings[0].old_path != old_path || mappings[0].new_path != final_path
    {
        return Err(AppError::InvalidInput(format!(
            "file rename journal must contain exactly old->final mapping: old={} final={}",
            old_path.display(),
            final_path.display()
        )));
    }
    Ok(())
}

fn validate_directory_journal_paths(
    old_path: &Path,
    final_path: &Path,
    mappings: &[DocumentRenameMapping],
) -> Result<(), AppError> {
    validate_unique_mappings(mappings)?;
    for mapping in mappings {
        if mapping.old_path == old_path || mapping.new_path == final_path {
            return Err(AppError::InvalidInput(format!(
                "directory rename journal mapping must be a strict descendant: old_root={} final_root={} old={} new={}",
                old_path.display(),
                final_path.display(),
                mapping.old_path.display(),
                mapping.new_path.display()
            )));
        }
        if !mapping.old_path.starts_with(old_path) || !mapping.new_path.starts_with(final_path) {
            return Err(AppError::InvalidInput(format!(
                "rename journal mapping is not tied to requested roots: old_root={} final_root={} old={} new={}",
                old_path.display(),
                final_path.display(),
                mapping.old_path.display(),
                mapping.new_path.display()
            )));
        }
        let old_rel = mapping
            .old_path
            .strip_prefix(old_path)
            .map_err(|e| AppError::InvalidInput(e.to_string()))?;
        let expected_new = final_path.join(old_rel);
        if mapping.new_path != expected_new {
            return Err(AppError::InvalidInput(format!(
                "rename journal mapping does not preserve relative path: old={} new={} expected_new={}",
                mapping.old_path.display(),
                mapping.new_path.display(),
                expected_new.display()
            )));
        }
    }
    Ok(())
}

struct CandidatePath {
    path: PathBuf,
    key: String,
    legacy: bool,
}

fn candidate_paths(
    project_dir: &Path,
    file_path: &Path,
    kind: SidecarKind,
) -> Result<Vec<CandidatePath>, AppError> {
    let canonical = document_key(project_dir, file_path)?;
    let canonical_path = sidecar_path(project_dir, kind.subdir, &canonical, kind.suffix)?;
    let mut paths = vec![CandidatePath {
        path: canonical_path.clone(),
        key: canonical,
        legacy: false,
    }];

    if kind.subdir == "drafts" {
        if let Some(legacy) = legacy_draft_key(project_dir, file_path) {
            let Some(legacy_path) =
                legacy_sidecar_path(project_dir, kind.subdir, &legacy, kind.suffix)?
            else {
                return Ok(paths);
            };
            if legacy_path != canonical_path {
                paths.push(CandidatePath {
                    path: legacy_path,
                    key: legacy,
                    legacy: true,
                });
            }
        }
    }

    Ok(paths)
}

fn legacy_draft_key(project_dir: &Path, file_path: &Path) -> Option<String> {
    let project = PathBuf::from(project_dir.to_string_lossy().replace('\\', "/"));
    let file = PathBuf::from(file_path.to_string_lossy().replace('\\', "/"));
    file.strip_prefix(&project)
        .ok()
        .map(|rel| rel.to_string_lossy().replace(['/', '\\'], "__"))
        .or_else(|| {
            file.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
}

pub(crate) fn draft_storage_key_has_live_owner(
    project_dir: &Path,
    requested_path: Option<&Path>,
    storage_key: &str,
) -> Result<bool, AppError> {
    let requested =
        requested_path.map(|path| PathBuf::from(path.to_string_lossy().replace('\\', "/")));
    storage_key_owner_in_dir(project_dir, project_dir, requested.as_deref(), storage_key)
}

fn storage_key_owner_in_dir(
    project_dir: &Path,
    dir: &Path,
    requested_path: Option<&Path>,
    storage_key: &str,
) -> Result<bool, AppError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || path.file_name().is_some_and(|name| name == ".novelist") {
            continue;
        }
        if file_type.is_dir() {
            if storage_key_owner_in_dir(project_dir, &path, requested_path, storage_key)? {
                return Ok(true);
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let normalized = PathBuf::from(path.to_string_lossy().replace('\\', "/"));
        if requested_path.is_some_and(|requested| normalized == requested) {
            continue;
        }
        let canonical_owner =
            document_key(project_dir, &path).is_ok_and(|candidate| candidate == storage_key);
        let legacy_owner = legacy_draft_key(project_dir, &path).as_deref() == Some(storage_key);
        if canonical_owner || legacy_owner {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn direct_mapping(old_path: &Path, new_path: &Path) -> Vec<DocumentRenameMapping> {
    vec![DocumentRenameMapping {
        old_path: old_path.to_path_buf(),
        new_path: new_path.to_path_buf(),
    }]
}

pub fn collect_planned_mappings(
    old_root: &Path,
    new_root: &Path,
) -> Result<Vec<DocumentRenameMapping>, AppError> {
    if old_root.is_file() {
        return Ok(direct_mapping(old_root, new_root));
    }
    let mut mappings = Vec::new();
    if old_root.is_dir() {
        collect_files(old_root, old_root, new_root, &mut mappings)?;
    }
    Ok(mappings)
}

fn collect_files(
    dir: &Path,
    old_root: &Path,
    new_root: &Path,
    mappings: &mut Vec<DocumentRenameMapping>,
) -> Result<(), AppError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_symlink() {
            continue;
        }
        if path.file_name().is_some_and(|name| name == ".novelist") {
            continue;
        }
        if path.is_dir() {
            collect_files(&path, old_root, new_root, mappings)?;
        } else if path.is_file() {
            let rel = path
                .strip_prefix(dir_root_for_path(&path, old_root, new_root))
                .map_err(|e| AppError::Custom(e.to_string()))?;
            mappings.push(DocumentRenameMapping {
                old_path: old_root.join(rel),
                new_path: new_root.join(rel),
            });
        }
    }
    Ok(())
}

fn dir_root_for_path<'a>(path: &Path, old_root: &'a Path, new_root: &'a Path) -> &'a Path {
    if path.starts_with(new_root) {
        new_root
    } else {
        old_root
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn sidecar(project: &Path, subdir: &str, file: &Path, suffix: &str) -> PathBuf {
        let key = document_key(project, file).unwrap();
        sidecar_path(project, subdir, &key, suffix).unwrap()
    }

    fn legacy_draft(project: &Path, file: &Path) -> PathBuf {
        let key = legacy_draft_key(project, file).unwrap();
        sidecar_path(project, "drafts", &key, ".draft.md").unwrap()
    }

    fn write(path: &Path, bytes: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[tokio::test]
    async fn oversized_sidecar_source_is_retained_and_reports_migration_error() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("旧章.md");
        let new = project.join("新章.md");
        let old_draft = sidecar(project, "drafts", &old, ".draft.md");
        let new_draft = sidecar(project, "drafts", &new, ".draft.md");
        fs::create_dir_all(old_draft.parent().unwrap()).unwrap();
        fs::File::create(&old_draft)
            .unwrap()
            .set_len(crate::services::sidecar::MAX_DRAFT_NOTE_BYTES as u64 + 1)
            .unwrap();

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(
            result.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert!(result.errors.iter().any(|error| error.contains("limit")));
        assert!(old_draft.exists());
        assert!(!new_draft.exists());
    }

    #[tokio::test]
    async fn appearing_journals_block_stale_literal_alias_reconciliation_across_chain() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let a = project.join("a__b.md");
        let b = project.join("intermediate.md");
        let c = project.join("a/b.md");
        write(&a, "# A");
        let reserved_source = sidecar(project, "drafts", &a, ".draft.md");
        assert_eq!(reserved_source, legacy_draft(project, &c));
        write(&reserved_source, "reserved A note");
        let (entered, release) = install_before_reconcile_guard_pause(project);

        let project_for_task = project.to_path_buf();
        let reconcile =
            tokio::spawn(async move { reconcile_project_draft_sidecars(&project_for_task).await });
        entered.await.unwrap();

        let guard = acquire_draft_transaction_guard(project).await.unwrap();
        let first = write_rename_journal(project, &a, &b, &direct_mapping(&a, &b))
            .await
            .unwrap();
        fs::rename(&a, &b).unwrap();
        fs::create_dir_all(c.parent().unwrap()).unwrap();
        let second = write_rename_journal(project, &b, &c, &direct_mapping(&b, &c))
            .await
            .unwrap();
        fs::rename(&b, &c).unwrap();
        release.send(()).unwrap();
        drop(guard);

        reconcile.await.unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(&reserved_source).unwrap(),
            "reserved A note"
        );
        assert!(!sidecar(project, "drafts", &c, ".draft.md").exists());
        assert!(first.path.exists());
        assert!(second.path.exists());
    }

    #[tokio::test]
    async fn two_reconcilers_recheck_journal_after_waiting_for_guard() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let literal = project.join("a__b.md");
        let renamed = project.join("renamed.md");
        let nested = project.join("a/b.md");
        write(&literal, "# Literal");
        write(&nested, "# Nested");
        let reserved_source = sidecar(project, "drafts", &literal, ".draft.md");
        assert_eq!(reserved_source, legacy_draft(project, &nested));
        write(&reserved_source, "reserved literal note");
        let (entered_one, release_one) = install_before_reconcile_guard_pause(project);
        let (entered_two, release_two) = install_before_reconcile_guard_pause(project);

        let project_one = project.to_path_buf();
        let first =
            tokio::spawn(async move { reconcile_project_draft_sidecars(&project_one).await });
        let project_two = project.to_path_buf();
        let second =
            tokio::spawn(async move { reconcile_project_draft_sidecars(&project_two).await });
        entered_one.await.unwrap();
        entered_two.await.unwrap();

        let guard = acquire_draft_transaction_guard(project).await.unwrap();
        let journal = write_rename_journal(
            project,
            &literal,
            &renamed,
            &direct_mapping(&literal, &renamed),
        )
        .await
        .unwrap();
        fs::rename(&literal, &renamed).unwrap();
        release_one.send(()).unwrap();
        release_two.send(()).unwrap();
        drop(guard);

        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(&reserved_source).unwrap(),
            "reserved literal note"
        );
        assert!(!sidecar(project, "drafts", &nested, ".draft.md").exists());
        assert!(journal.path.exists());
    }

    #[tokio::test]
    async fn disappearing_journal_is_rechecked_after_reconcile_waits_for_guard() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("chapters/one.md");
        let old = project.join("reserved.md");
        let renamed = project.join("renamed.md");
        write(&file, "# One");
        write(&old, "# Reserved");
        let legacy = legacy_draft(project, &file);
        write(&legacy, "legacy note");

        let guard = acquire_draft_transaction_guard(project).await.unwrap();
        let journal =
            write_rename_journal(project, &old, &renamed, &direct_mapping(&old, &renamed))
                .await
                .unwrap();
        let project_for_task = project.to_path_buf();
        let mut reconcile =
            tokio::spawn(async move { reconcile_project_draft_sidecars(&project_for_task).await });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut reconcile)
                .await
                .is_err()
        );
        remove_rename_journal(&journal.path).await.unwrap();
        drop(guard);

        reconcile.await.unwrap().unwrap();
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(sidecar(project, "drafts", &file, ".draft.md")).unwrap(),
            "legacy note"
        );
    }

    #[tokio::test]
    async fn file_chain_converges_to_one_active_key_and_retry_adds_no_conflicts() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let a = project.join("a.md");
        let b = project.join("b.md");
        let c = project.join("c.md");
        write(&legacy_draft(project, &a), "notes");

        let first = migrate_rename_sidecars(project, &direct_mapping(&a, &b), false).await;
        assert_eq!(first.status, RenameMigrationStatus::FullSuccess);
        let second = migrate_rename_sidecars(project, &direct_mapping(&b, &c), false).await;
        assert_eq!(second.status, RenameMigrationStatus::FullSuccess);
        let retry = migrate_rename_sidecars(project, &direct_mapping(&b, &c), true).await;
        assert_eq!(retry.status, RenameMigrationStatus::IdempotentRetry);

        assert!(!legacy_draft(project, &a).exists());
        assert!(!sidecar(project, "drafts", &b, ".draft.md").exists());
        assert_eq!(
            fs::read_to_string(sidecar(project, "drafts", &c, ".draft.md")).unwrap(),
            "notes"
        );

        let draft_dir = project.join(".novelist/drafts");
        let conflict_count = fs::read_dir(draft_dir)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".conflict-")
            })
            .count();
        assert_eq!(conflict_count, 0);
    }

    #[tokio::test]
    async fn conflicting_distinct_metadata_keeps_newest_active_and_one_stable_conflict() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("old.md");
        let new = project.join("new.md");
        let old_sidecar = sidecar(project, "publish", &old, ".json");
        let new_sidecar = sidecar(project, "publish", &new, ".json");
        write(&old_sidecar, "old distinct");
        std::thread::sleep(std::time::Duration::from_millis(5));
        write(&new_sidecar, "new distinct");

        let first = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;
        let retry = migrate_rename_sidecars(project, &direct_mapping(&old, &new), true).await;

        assert_eq!(first.conflicts, 1);
        assert_eq!(retry.conflicts, 0);
        assert_eq!(fs::read_to_string(&new_sidecar).unwrap(), "new distinct");
        let conflicts: Vec<_> = fs::read_dir(project.join(".novelist/publish"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".conflict-"))
            .collect();
        assert_eq!(conflicts.len(), 1);
    }

    #[tokio::test]
    async fn destination_draft_conflict_keeps_newest_active_and_retry_adds_no_copy() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("old.md");
        let new = project.join("new.md");
        let old_draft = sidecar(project, "drafts", &old, ".draft.md");
        let new_draft = sidecar(project, "drafts", &new, ".draft.md");
        write(&old_draft, "older source draft");
        std::thread::sleep(std::time::Duration::from_millis(5));
        write(&new_draft, "newer destination draft");

        let first = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;
        let retry = migrate_rename_sidecars(project, &direct_mapping(&old, &new), true).await;

        assert_eq!(first.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(first.conflicts, 1);
        assert_eq!(retry.status, RenameMigrationStatus::IdempotentRetry);
        assert_eq!(retry.conflicts, 0);
        assert_eq!(
            fs::read_to_string(&new_draft).unwrap(),
            "newer destination draft"
        );
        assert!(!old_draft.exists());
        let conflicts: Vec<_> = fs::read_dir(project.join(".novelist/drafts"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".conflict-")
            })
            .collect();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(
            fs::read_to_string(&conflicts[0]).unwrap(),
            "older source draft"
        );
    }

    #[tokio::test]
    async fn source_newer_metadata_becomes_active_and_preserves_older_dest_conflict_once() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("old.md");
        let new = project.join("new.md");
        let old_sidecar = sidecar(project, "publish", &old, ".json");
        let new_sidecar = sidecar(project, "publish", &new, ".json");
        write(&new_sidecar, "older destination");
        std::thread::sleep(std::time::Duration::from_millis(5));
        write(&old_sidecar, "newer source");

        let first = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;
        let retry = migrate_rename_sidecars(project, &direct_mapping(&old, &new), true).await;

        assert_eq!(first.conflicts, 1);
        assert_eq!(retry.conflicts, 0);
        assert_eq!(fs::read_to_string(&new_sidecar).unwrap(), "newer source");
        let conflicts: Vec<_> = fs::read_dir(project.join(".novelist/publish"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".conflict-")
            })
            .collect();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(
            fs::read_to_string(&conflicts[0]).unwrap(),
            "older destination"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn publish_migration_rejects_symlinked_directory_without_touching_external_files() {
        use std::os::unix::fs::symlink;

        let project_dir = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let project = project_dir.path();
        let old = project.join("旧 章节.md");
        let new = project.join("新 章节.md");
        fs::create_dir(project.join(".novelist")).unwrap();
        symlink(
            outside_dir.path(),
            project.join(".novelist").join("publish"),
        )
        .unwrap();
        let old_name = sidecar(project, "publish", &old, ".json")
            .file_name()
            .unwrap()
            .to_owned();
        let new_name = sidecar(project, "publish", &new, ".json")
            .file_name()
            .unwrap()
            .to_owned();
        let outside_source = outside_dir.path().join(old_name);
        let outside_destination = outside_dir.path().join(new_name);
        write(&outside_source, "external sentinel");

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(
            result.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert_eq!(
            fs::read_to_string(&outside_source).unwrap(),
            "external sentinel"
        );
        assert!(!outside_destination.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn publish_migration_rejects_symlinked_source_file_without_copying_external_bytes() {
        use std::os::unix::fs::symlink;

        let project_dir = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let project = project_dir.path();
        let old = project.join("旧 章节.md");
        let new = project.join("新 章节.md");
        let old_sidecar = sidecar(project, "publish", &old, ".json");
        let new_sidecar = sidecar(project, "publish", &new, ".json");
        fs::create_dir_all(old_sidecar.parent().unwrap()).unwrap();
        let outside_source = outside_dir.path().join("outside.json");
        write(&outside_source, "external sentinel");
        symlink(&outside_source, &old_sidecar).unwrap();

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(
            result.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert_eq!(
            fs::read_to_string(&outside_source).unwrap(),
            "external sentinel"
        );
        assert!(old_sidecar
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!new_sidecar.exists());
    }

    #[tokio::test]
    async fn publish_migration_preserves_cover_ref_across_cjk_space_rename() {
        use crate::services::publish::cover_assets::CoverRef;
        use crate::services::publish::sidecar::{
            read_publish_sidecar, write_publish_sidecar, ChannelState, FormDraft, PublishSidecar,
        };

        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("第一卷/旧 章节.md");
        let new = project.join("第一卷/新 章节.md");
        let cover = CoverRef {
            content_hash: "a".repeat(64),
            mime: "image/png".to_string(),
            extension: "png".to_string(),
            bytes: 128,
        };
        let mut publish = PublishSidecar::default();
        publish.channels.insert(
            "ghost-main".to_string(),
            ChannelState {
                form: FormDraft::default(),
                remote: None,
                cover: Some(cover.clone()),
            },
        );
        write_publish_sidecar(project, &old, &publish)
            .await
            .unwrap();

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(result.status, RenameMigrationStatus::FullSuccess);
        assert!(read_publish_sidecar(project, &old).await.unwrap().is_none());
        let migrated = read_publish_sidecar(project, &new)
            .await
            .unwrap()
            .expect("renamed publish sidecar");
        assert_eq!(migrated.channels["ghost-main"].cover, Some(cover));
    }

    #[tokio::test]
    async fn publish_migration_waits_for_project_cover_transaction_lock() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_path_buf();
        let old = project.join("旧 章节.md");
        let new = project.join("新 章节.md");
        write(&sidecar(&project, "publish", &old, ".json"), "publish");
        let mutex =
            crate::services::publish::sidecar::acquire_cover_asset_transaction_lock(&project)
                .await
                .unwrap();
        let guard = mutex.lock().await;
        let mappings = direct_mapping(&old, &new);
        let mut migration = tokio::spawn({
            let project = project.clone();
            async move { migrate_rename_sidecars(&project, &mappings, false).await }
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut migration)
                .await
                .is_err(),
            "publish migration bypassed the project cover transaction lock"
        );
        drop(guard);
        let result = migration.await.unwrap();
        assert_eq!(result.status, RenameMigrationStatus::FullSuccess);
        assert!(!sidecar(&project, "publish", &old, ".json").exists());
        assert_eq!(
            fs::read_to_string(sidecar(&project, "publish", &new, ".json")).unwrap(),
            "publish"
        );
    }

    #[tokio::test]
    async fn managed_name_payload_updates_document_key_and_preserves_status() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("旧.md");
        let new = project.join("新.md");
        write(
            &sidecar(project, "naming", &old, ".json"),
            r#"{"version":1,"status":"detached","templateRaw":"第{N}章-{title}","currentH1":"题","documentKey":"旧.md"}"#,
        );

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(result.status, RenameMigrationStatus::FullSuccess);
        let raw = fs::read_to_string(sidecar(project, "naming", &new, ".json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["status"], "detached");
        assert_eq!(value["documentKey"], document_key(project, &new).unwrap());
    }

    #[tokio::test]
    async fn managed_name_semantic_equivalent_json_dedupes_without_conflict() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("old.md");
        let new = project.join("new.md");
        let new_key = document_key(project, &new).unwrap();
        write(
            &sidecar(project, "naming", &old, ".json"),
            r#"{"version":1,"status":"detached","documentKey":"old.md","currentH1":"Title"}"#,
        );
        write(
            &sidecar(project, "naming", &new, ".json"),
            &format!(
                "{{\n  \"currentH1\": \"Title\",\n  \"documentKey\": {new_key:?},\n  \"status\": \"detached\",\n  \"version\": 1\n}}"
            ),
        );

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(result.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(result.conflicts, 0);
        assert!(!sidecar(project, "naming", &old, ".json").exists());
        let conflict_count = fs::read_dir(project.join(".novelist/naming"))
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".conflict-")
            })
            .count();
        assert_eq!(conflict_count, 0);
    }

    #[tokio::test]
    async fn malformed_managed_name_payload_fails_closed_and_keeps_source() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("old.md");
        let new = project.join("new.md");
        let old_sidecar = sidecar(project, "naming", &old, ".json");
        write(&old_sidecar, "{not json");

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(
            result.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert!(old_sidecar.exists());
        assert!(result.errors.iter().any(|error| {
            error.contains("kind=naming")
                && error.contains(&old.to_string_lossy().to_string())
                && error.contains(&new.to_string_lossy().to_string())
        }));
    }

    #[tokio::test]
    async fn folder_descendants_migrate_after_filesystem_move_mapping_collection() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old_root = project.join("旧目录");
        let new_root = project.join("新目录");
        let old_file = old_root.join("深/第一章.md");
        let new_file = new_root.join("深/第一章.md");
        write(&old_file, "doc");
        write(&sidecar(project, "publish", &old_file, ".json"), "publish");
        let mappings = collect_planned_mappings(&old_root, &new_root).unwrap();
        fs::rename(&old_root, &new_root).unwrap();

        let result = migrate_rename_sidecars(project, &mappings, false).await;

        assert_eq!(result.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(
            fs::read_to_string(sidecar(project, "publish", &new_file, ".json")).unwrap(),
            "publish"
        );
        assert!(!sidecar(project, "publish", &old_file, ".json").exists());
    }

    #[tokio::test]
    async fn recovery_draft_chain_migrates_independently_from_normal_draft() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let a = project.join("a.md");
        let b = project.join("b.md");
        let c = project.join("c.md");
        write(&legacy_draft(project, &a), "note-a");
        write(
            &legacy_draft(
                project,
                &PathBuf::from(format!("{}.~recovery", a.display())),
            ),
            "recovery-a",
        );

        assert_eq!(
            migrate_rename_sidecars(project, &direct_mapping(&a, &b), false)
                .await
                .status,
            RenameMigrationStatus::FullSuccess
        );
        write(
            &legacy_draft(
                project,
                &PathBuf::from(format!("{}.~recovery", b.display())),
            ),
            "recovery-edited",
        );
        assert_eq!(
            migrate_rename_sidecars(project, &direct_mapping(&b, &c), false)
                .await
                .status,
            RenameMigrationStatus::FullSuccess
        );

        assert_eq!(
            fs::read_to_string(sidecar(project, "drafts", &c, ".draft.md")).unwrap(),
            "note-a"
        );
        assert_eq!(
            fs::read_to_string(sidecar(
                project,
                "drafts",
                &PathBuf::from(format!("{}.~recovery", c.display())),
                ".draft.md"
            ))
            .unwrap(),
            "recovery-edited"
        );
    }

    #[tokio::test]
    async fn mismatched_existing_conflict_preserves_source_and_reports_error() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("old.md");
        let new = project.join("new.md");
        let old_sidecar = sidecar(project, "publish", &old, ".json");
        let new_sidecar = sidecar(project, "publish", &new, ".json");
        write(&old_sidecar, "older");
        std::thread::sleep(std::time::Duration::from_millis(5));
        write(&new_sidecar, "newer");
        let marker = conflict_marker(&new_sidecar, &old_sidecar, b"older", b"newer");
        write(
            &conflict_copy_path(&new_sidecar, &marker).unwrap(),
            "different conflict bytes",
        );

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(
            result.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert!(
            old_sidecar.exists(),
            "source must remain when conflict persistence is uncertain"
        );
        assert_eq!(fs::read_to_string(&new_sidecar).unwrap(), "newer");
    }

    #[test]
    fn folder_mapping_skips_symlinked_descendants() {
        let dir = TempDir::new().unwrap();
        let old_root = dir.path().join("old");
        let new_root = dir.path().join("new");
        fs::create_dir_all(&old_root).unwrap();
        write(&old_root.join("real.md"), "real");
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path(), old_root.join("link-out")).unwrap();

        let mappings = collect_planned_mappings(&old_root, &new_root).unwrap();

        assert_eq!(
            mappings,
            vec![DocumentRenameMapping {
                old_path: old_root.join("real.md"),
                new_path: new_root.join("real.md")
            }]
        );
    }

    const EXPECTED_MAX_RENAME_JOURNAL_BYTES: usize = 8 * 1024 * 1024;

    #[tokio::test]
    async fn load_rejects_oversized_rename_journal_and_retains_source() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("旧章.md");
        let new = project.join("新章.md");
        write(&old, "doc");
        let path = journal_path(project, &old, &new).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(&path)
            .unwrap()
            .set_len(EXPECTED_MAX_RENAME_JOURNAL_BYTES as u64 + 1)
            .unwrap();

        let error = load_matching_journal(project, &old, &new)
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert_eq!(
            fs::metadata(path).unwrap().len(),
            EXPECTED_MAX_RENAME_JOURNAL_BYTES as u64 + 1
        );
    }

    #[tokio::test]
    async fn journal_scanner_rejects_oversized_file_and_retains_source() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let journal = project
            .join(".novelist")
            .join(JOURNAL_SUBDIR)
            .join("oversized.json");
        fs::create_dir_all(journal.parent().unwrap()).unwrap();
        fs::File::create(&journal)
            .unwrap()
            .set_len(EXPECTED_MAX_RENAME_JOURNAL_BYTES as u64 + 1)
            .unwrap();

        let error = ensure_draft_key_not_reserved(project, &project.join("第一章.md"), "第一章.md")
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert_eq!(
            fs::metadata(journal).unwrap().len(),
            EXPECTED_MAX_RENAME_JOURNAL_BYTES as u64 + 1
        );
    }

    #[tokio::test]
    async fn write_rejects_rename_journal_over_reader_cap_without_creating_file() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old_root = project.join("旧目录");
        let new_root = project.join("新目录");
        fs::create_dir(&old_root).unwrap();
        let long_relative = "x".repeat(EXPECTED_MAX_RENAME_JOURNAL_BYTES / 2 + 1024);
        let mappings = vec![DocumentRenameMapping {
            old_path: old_root.join(&long_relative),
            new_path: new_root.join(&long_relative),
        }];
        let path = journal_path(project, &old_root, &new_root).unwrap();

        let error = write_rename_journal(project, &old_root, &new_root, &mappings)
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn journal_operations_reject_symlinked_directory_without_touching_outside_file() {
        use std::os::unix::fs::symlink;

        let project_dir = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let project = project_dir.path();
        let old = project.join("旧章.md");
        let new = project.join("新章.md");
        let mappings = direct_mapping(&old, &new);
        write(&old, "doc");
        fs::create_dir(project.join(".novelist")).unwrap();
        symlink(
            outside_dir.path(),
            project.join(".novelist").join(JOURNAL_SUBDIR),
        )
        .unwrap();
        let path = journal_path(project, &old, &new).unwrap();
        let outside_path = outside_dir.path().join(path.file_name().unwrap());
        let journal = RenameJournal {
            schema_version: JOURNAL_SCHEMA_VERSION,
            root_kind: RenameRootKind::File,
            project_dir: project.to_path_buf(),
            old_path: old.clone(),
            final_path: new.clone(),
            mappings: mappings.clone(),
        };
        let original_bytes = serde_json::to_vec_pretty(&journal).unwrap();
        fs::write(&outside_path, &original_bytes).unwrap();

        let load_error = load_matching_journal(project, &old, &new)
            .await
            .unwrap_err();
        let write_error = write_rename_journal(project, &old, &new, &mappings)
            .await
            .unwrap_err();
        let remove_error = remove_rename_journal(&path).await.unwrap_err();

        assert!(matches!(load_error, AppError::PathNotAllowed(_)));
        assert!(matches!(write_error, AppError::PathNotAllowed(_)));
        assert!(matches!(remove_error, AppError::PathNotAllowed(_)));
        assert_eq!(fs::read(outside_path).unwrap(), original_bytes);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn journal_scanner_rejects_symlinked_directory_without_reading_outside_file() {
        use std::os::unix::fs::symlink;

        let project_dir = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let project = project_dir.path();
        fs::create_dir(project.join(".novelist")).unwrap();
        symlink(
            outside_dir.path(),
            project.join(".novelist").join(JOURNAL_SUBDIR),
        )
        .unwrap();
        let journal = RenameJournal {
            schema_version: JOURNAL_SCHEMA_VERSION,
            root_kind: RenameRootKind::Directory,
            project_dir: project.to_path_buf(),
            old_path: project.join("旧目录"),
            final_path: project.join("新目录"),
            mappings: Vec::new(),
        };
        let outside_path = outside_dir.path().join("outside.json");
        let original_bytes = serde_json::to_vec_pretty(&journal).unwrap();
        fs::write(&outside_path, &original_bytes).unwrap();

        let error = ensure_draft_key_not_reserved(project, &project.join("第一章.md"), "第一章.md")
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::PathNotAllowed(_)));
        assert_eq!(fs::read(outside_path).unwrap(), original_bytes);
    }

    #[tokio::test]
    async fn journal_retry_uses_persisted_mappings_and_removes_on_success() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("a.md");
        let new = project.join("b.md");
        let mappings = direct_mapping(&old, &new);
        write(&old, "doc");
        write(&sidecar(project, "publish", &old, ".json"), "publish");

        let journal = write_rename_journal(project, &old, &new, &mappings)
            .await
            .unwrap();
        fs::rename(
            sidecar(project, "publish", &old, ".json"),
            sidecar(project, "publish", &new, ".json"),
        )
        .unwrap();
        let loaded = load_matching_journal(project, &old, &new)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.journal.mappings, mappings);
        remove_rename_journal(&journal.path).await.unwrap();

        assert!(load_matching_journal(project, &old, &new)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn journal_rejects_file_mapping_that_is_not_exact_old_to_final() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("old.md");
        let new = project.join("new.md");
        let unrelated = project.join("other.md");
        write(&old, "doc");

        let result = write_rename_journal(
            project,
            &old,
            &new,
            &[DocumentRenameMapping {
                old_path: old.clone(),
                new_path: unrelated,
            }],
        )
        .await;

        assert!(matches!(result, Err(AppError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn journal_rejects_empty_mappings_for_file_root() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("old.md");
        let new = project.join("new.md");
        write(&old, "doc");

        let result = write_rename_journal(project, &old, &new, &[]).await;

        assert!(matches!(result, Err(AppError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn journal_allows_empty_mappings_for_directory_root() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old_root = project.join("old");
        let new_root = project.join("new");
        fs::create_dir(&old_root).unwrap();

        let journal = write_rename_journal(project, &old_root, &new_root, &[])
            .await
            .unwrap();

        let loaded = load_matching_journal(project, &old_root, &new_root)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.journal.mappings, Vec::<DocumentRenameMapping>::new());
        remove_rename_journal(&journal.path).await.unwrap();
    }

    #[tokio::test]
    async fn journal_rejects_folder_mapping_with_cross_mapped_relative_path() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old_root = project.join("old");
        let new_root = project.join("new");
        fs::create_dir(&old_root).unwrap();

        let result = write_rename_journal(
            project,
            &old_root,
            &new_root,
            &[DocumentRenameMapping {
                old_path: old_root.join("a.md"),
                new_path: new_root.join("nested/a.md"),
            }],
        )
        .await;

        assert!(matches!(result, Err(AppError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn journal_rejects_directory_root_self_mapping() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old_root = project.join("old");
        let new_root = project.join("new");
        fs::create_dir(&old_root).unwrap();

        let result = write_rename_journal(
            project,
            &old_root,
            &new_root,
            &[DocumentRenameMapping {
                old_path: old_root.clone(),
                new_path: new_root.clone(),
            }],
        )
        .await;

        assert!(matches!(result, Err(AppError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn journal_rejects_duplicate_mappings() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old_root = project.join("old");
        let new_root = project.join("new");
        fs::create_dir(&old_root).unwrap();
        let mapping = DocumentRenameMapping {
            old_path: old_root.join("a.md"),
            new_path: new_root.join("a.md"),
        };

        let result =
            write_rename_journal(project, &old_root, &new_root, &[mapping.clone(), mapping]).await;

        assert!(matches!(result, Err(AppError::InvalidInput(_))));
    }
}
