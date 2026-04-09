//! Rope-backed document service for large file viewport editing.
//!
//! The Rope (via `ropey`) is the source of truth for large files.
//! The frontend CM6 editor only holds a window of ~2000 lines.
//! Edits are applied both locally in CM6 and dispatched here.
//!
//! Key operations:
//! - open: Load file into Rope, return metadata
//! - get_lines: Return text for a line range (viewport loading)
//! - apply_edit: Apply a text change at byte offset
//! - save: Write Rope to disk atomically
//! - close: Release memory

use crate::error::AppError;
use ropey::Rope;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct RopeDocument {
    pub rope: Rope,
    pub file_path: PathBuf,
    pub dirty: bool,
    pub generation: u64,
}

/// Shared state holding all open Rope documents.
pub struct RopeDocumentState {
    pub docs: Mutex<HashMap<String, RopeDocument>>,
}

impl RopeDocumentState {
    pub fn new() -> Self {
        Self {
            docs: Mutex::new(HashMap::new()),
        }
    }
}

macro_rules! lock_docs {
    ($state:expr) => {
        $state
            .docs
            .lock()
            .map_err(|e| AppError::Custom(format!("Lock poisoned: {}", e)))
    };
}

#[derive(serde::Serialize, specta::Type)]
pub struct RopeDocumentMeta {
    pub file_id: String,
    pub total_lines: usize,
    pub total_bytes: usize,
}

#[derive(serde::Serialize, specta::Type)]
pub struct ViewportContent {
    /// The text content for the requested line range
    pub text: String,
    /// Actual start line (0-indexed)
    pub start_line: usize,
    /// Actual end line (exclusive, 0-indexed)
    pub end_line: usize,
    /// Total lines in document (can change after edits)
    pub total_lines: usize,
}

/// Open a large file into a Rope. Returns metadata.
#[tauri::command]
#[specta::specta]
pub fn rope_open(
    path: String,
    state: tauri::State<'_, RopeDocumentState>,
) -> Result<RopeDocumentMeta, AppError> {
    let rope = Rope::from_reader(std::io::BufReader::new(std::fs::File::open(&path)?))
        .map_err(|e| AppError::Custom(format!("Failed to load rope: {}", e)))?;

    let total_lines = rope.len_lines();
    let total_bytes = rope.len_bytes();
    let file_id = path.clone();

    let doc = RopeDocument {
        rope,
        file_path: PathBuf::from(&path),
        dirty: false,
        generation: 0,
    };

    state
        .docs
        .lock()
        .map_err(|e| AppError::Custom(format!("Lock poisoned: {}", e)))?
        .insert(file_id.clone(), doc);

    Ok(RopeDocumentMeta {
        file_id,
        total_lines,
        total_bytes,
    })
}

/// Get text for a range of lines. Lines are 0-indexed.
/// Returns the text and actual line range (clamped to document bounds).
#[tauri::command]
#[specta::specta]
pub fn rope_get_lines(
    file_id: String,
    start_line: usize,
    end_line: usize,
    state: tauri::State<'_, RopeDocumentState>,
) -> Result<ViewportContent, AppError> {
    let docs = lock_docs!(state)?;
    let doc = docs
        .get(&file_id)
        .ok_or_else(|| AppError::Custom(format!("Rope document not found: {}", file_id)))?;

    let total_lines = doc.rope.len_lines();
    let start = start_line.min(total_lines.saturating_sub(1));
    let end = end_line.min(total_lines);

    if start >= end {
        return Ok(ViewportContent {
            text: String::new(),
            start_line: start,
            end_line: start,
            total_lines,
        });
    }

    let start_char = doc.rope.line_to_char(start);
    let end_char = if end >= total_lines {
        doc.rope.len_chars()
    } else {
        doc.rope.line_to_char(end)
    };

    let text = doc.rope.slice(start_char..end_char).to_string();

    Ok(ViewportContent {
        text,
        start_line: start,
        end_line: end,
        total_lines,
    })
}

/// Apply an edit to the Rope at character offsets.
/// `from` and `to` are character (not byte) offsets relative to the full document.
/// `insert` is the replacement text (empty string = deletion).
#[tauri::command]
#[specta::specta]
pub fn rope_apply_edit(
    file_id: String,
    from_char: usize,
    to_char: usize,
    insert: String,
    state: tauri::State<'_, RopeDocumentState>,
) -> Result<usize, AppError> {
    let mut docs = lock_docs!(state)?;
    let doc = docs
        .get_mut(&file_id)
        .ok_or_else(|| AppError::Custom(format!("Rope document not found: {}", file_id)))?;

    // Clamp to valid range
    let len = doc.rope.len_chars();
    let from = from_char.min(len);
    let to = to_char.min(len);

    // Remove old text
    if to > from {
        doc.rope.remove(from..to);
    }

    // Insert new text
    if !insert.is_empty() {
        doc.rope.insert(from, &insert);
    }

    doc.dirty = true;
    doc.generation += 1;
    Ok(doc.rope.len_lines())
}

/// Save the Rope to disk atomically.
#[tauri::command]
#[specta::specta]
pub async fn rope_save(
    file_id: String,
    state: tauri::State<'_, RopeDocumentState>,
) -> Result<(), AppError> {
    let (text, file_path, line_count, saved_generation) = {
        let docs = lock_docs!(state)?;
        let doc = docs
            .get(&file_id)
            .ok_or_else(|| AppError::Custom(format!("Rope document not found: {}", file_id)))?;
        let lines = doc.rope.len_lines();
        let text = doc.rope.to_string();
        tracing::info!(
            "[rope_save] file={}, rope_lines={}, text_bytes={}, text_lines={}",
            doc.file_path.display(),
            lines,
            text.len(),
            text.lines().count()
        );
        (text, doc.file_path.clone(), lines, doc.generation)
    };

    let temp_path = format!("{}.novelist-tmp", file_path.display());
    tokio::fs::write(&temp_path, &text).await?;
    tokio::fs::rename(&temp_path, &file_path).await?;

    tracing::info!(
        "[rope_save] DONE: wrote {} bytes, {} lines to {}",
        text.len(),
        line_count,
        file_path.display()
    );

    let mut docs = lock_docs!(state)?;
    if let Some(doc) = docs.get_mut(&file_id) {
        if doc.generation == saved_generation {
            doc.dirty = false;
        }
    }

    Ok(())
}

/// Close a Rope document and release memory.
#[tauri::command]
#[specta::specta]
pub fn rope_close(
    file_id: String,
    state: tauri::State<'_, RopeDocumentState>,
) -> Result<(), AppError> {
    state.docs.lock().unwrap().remove(&file_id);
    Ok(())
}

/// Get the character offset for a given line number (0-indexed).
#[tauri::command]
#[specta::specta]
pub fn rope_line_to_char(
    file_id: String,
    line: usize,
    state: tauri::State<'_, RopeDocumentState>,
) -> Result<usize, AppError> {
    let docs = lock_docs!(state)?;
    let doc = docs
        .get(&file_id)
        .ok_or_else(|| AppError::Custom(format!("Rope document not found: {}", file_id)))?;
    let clamped = line.min(doc.rope.len_lines().saturating_sub(1));
    Ok(doc.rope.line_to_char(clamped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_state_with_doc(content: &str) -> (RopeDocumentState, String) {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("test.md");
        std::fs::write(&path, content).unwrap();
        let file_id = path.to_string_lossy().to_string();

        let state = RopeDocumentState::new();
        let rope = Rope::from_str(content);
        state.docs.lock().unwrap().insert(
            file_id.clone(),
            RopeDocument {
                rope,
                file_path: PathBuf::from(&file_id),
                dirty: false,
                generation: 0,
            },
        );
        (state, file_id)
    }

    #[test]
    fn test_state_new_is_empty() {
        let state = RopeDocumentState::new();
        assert!(state.docs.lock().unwrap().is_empty());
    }

    #[test]
    fn test_open_and_metadata() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("test.md");
        {
            let mut f = std::fs::File::create(&path).unwrap();
            for i in 0..100 {
                writeln!(f, "Line {}", i).unwrap();
            }
        }

        let state = RopeDocumentState::new();
        let rope = Rope::from_reader(std::io::BufReader::new(std::fs::File::open(&path).unwrap()))
            .unwrap();
        let total_lines = rope.len_lines();
        let total_bytes = rope.len_bytes();
        let file_id = path.to_string_lossy().to_string();

        state.docs.lock().unwrap().insert(
            file_id.clone(),
            RopeDocument {
                rope,
                file_path: path,
                dirty: false,
                generation: 0,
            },
        );

        assert_eq!(total_lines, 101); // 100 lines + trailing newline
        assert!(total_bytes > 0);
        assert!(state.docs.lock().unwrap().contains_key(&file_id));
    }

    #[test]
    fn test_get_lines_basic() {
        let content = "line0\nline1\nline2\nline3\nline4\n";
        let (state, file_id) = make_state_with_doc(content);

        let docs = state.docs.lock().unwrap();
        let doc = docs.get(&file_id).unwrap();
        let sc = doc.rope.line_to_char(1);
        let ec = doc.rope.line_to_char(3);
        let text = doc.rope.slice(sc..ec).to_string();
        assert_eq!(text, "line1\nline2\n");
    }

    #[test]
    fn test_get_lines_clamped() {
        let content = "a\nb\nc\n";
        let (state, file_id) = make_state_with_doc(content);

        let docs = state.docs.lock().unwrap();
        let doc = docs.get(&file_id).unwrap();
        let total = doc.rope.len_lines();
        // Request beyond bounds
        let start = 0.min(total.saturating_sub(1));
        let end = 999.min(total);
        let sc = doc.rope.line_to_char(start);
        let ec = doc.rope.line_to_char(end);
        let text = doc.rope.slice(sc..ec).to_string();
        assert_eq!(text, content);
    }

    #[test]
    fn test_apply_edit_insert() {
        let content = "Hello World";
        let (state, file_id) = make_state_with_doc(content);

        {
            let mut docs = state.docs.lock().unwrap();
            let doc = docs.get_mut(&file_id).unwrap();
            // Insert ", Beautiful" at position 5
            doc.rope.insert(5, ", Beautiful");
            doc.dirty = true;
        }

        let docs = state.docs.lock().unwrap();
        let doc = docs.get(&file_id).unwrap();
        assert_eq!(doc.rope.to_string(), "Hello, Beautiful World");
        assert!(doc.dirty);
    }

    #[test]
    fn test_apply_edit_delete() {
        let content = "Hello Beautiful World";
        let (state, file_id) = make_state_with_doc(content);

        {
            let mut docs = state.docs.lock().unwrap();
            let doc = docs.get_mut(&file_id).unwrap();
            // Remove " Beautiful" (chars 5..15)
            doc.rope.remove(5..15);
        }

        let docs = state.docs.lock().unwrap();
        let doc = docs.get(&file_id).unwrap();
        assert_eq!(doc.rope.to_string(), "Hello World");
    }

    #[test]
    fn test_apply_edit_replace() {
        let content = "Hello World";
        let (state, file_id) = make_state_with_doc(content);

        {
            let mut docs = state.docs.lock().unwrap();
            let doc = docs.get_mut(&file_id).unwrap();
            // Replace "World" (chars 6..11) with "Rust"
            doc.rope.remove(6..11);
            doc.rope.insert(6, "Rust");
        }

        let docs = state.docs.lock().unwrap();
        let doc = docs.get(&file_id).unwrap();
        assert_eq!(doc.rope.to_string(), "Hello Rust");
    }

    #[test]
    fn test_close_removes_document() {
        let content = "test";
        let (state, file_id) = make_state_with_doc(content);

        assert!(state.docs.lock().unwrap().contains_key(&file_id));
        state.docs.lock().unwrap().remove(&file_id);
        assert!(!state.docs.lock().unwrap().contains_key(&file_id));
    }

    #[test]
    fn test_line_to_char_basic() {
        let content = "abc\ndef\nghi\n";
        let (state, file_id) = make_state_with_doc(content);

        let docs = state.docs.lock().unwrap();
        let doc = docs.get(&file_id).unwrap();
        assert_eq!(doc.rope.line_to_char(0), 0);
        assert_eq!(doc.rope.line_to_char(1), 4); // "abc\n" = 4 chars
        assert_eq!(doc.rope.line_to_char(2), 8); // "abc\ndef\n" = 8 chars
    }

    #[test]
    fn test_cjk_content() {
        let content = "第一章\n落霞与孤鹜齐飞\n秋水共长天一色\n";
        let (state, file_id) = make_state_with_doc(content);

        let docs = state.docs.lock().unwrap();
        let doc = docs.get(&file_id).unwrap();
        assert_eq!(doc.rope.len_lines(), 4); // 3 lines + trailing newline
        let line1 = doc.rope.line(1).to_string();
        assert_eq!(line1, "落霞与孤鹜齐飞\n");
    }

    #[test]
    fn test_multiple_documents() {
        let state = RopeDocumentState::new();

        let doc1 = RopeDocument {
            rope: Rope::from_str("doc1"),
            file_path: PathBuf::from("/tmp/doc1.md"),
            dirty: false,
            generation: 0,
        };
        let doc2 = RopeDocument {
            rope: Rope::from_str("doc2"),
            file_path: PathBuf::from("/tmp/doc2.md"),
            dirty: false,
            generation: 0,
        };

        {
            let mut docs = state.docs.lock().unwrap();
            docs.insert("doc1".to_string(), doc1);
            docs.insert("doc2".to_string(), doc2);
        }

        let docs = state.docs.lock().unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs.get("doc1").unwrap().rope.to_string(), "doc1");
        assert_eq!(docs.get("doc2").unwrap().rope.to_string(), "doc2");
    }

    #[test]
    fn test_save_roundtrip() {
        let content = "# Title\n\nParagraph one.\n\nParagraph two.\n";
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("save_test.md");
        std::fs::write(&path, content).unwrap();

        let rope = Rope::from_reader(std::io::BufReader::new(std::fs::File::open(&path).unwrap()))
            .unwrap();

        // Modify
        let mut rope = rope;
        rope.insert(0, "PREPEND\n");

        // Save
        let saved = rope.to_string();
        let temp_path = format!("{}.novelist-tmp", path.display());
        std::fs::write(&temp_path, &saved).unwrap();
        std::fs::rename(&temp_path, &path).unwrap();

        // Verify
        let reloaded = std::fs::read_to_string(&path).unwrap();
        assert_eq!(reloaded, saved);
        assert!(reloaded.starts_with("PREPEND\n# Title\n"));
    }

    #[test]
    fn test_viewport_reads_dont_mutate() {
        let content = "line0\nline1\nline2\nline3\nline4\n";
        let (state, file_id) = make_state_with_doc(content);

        let docs = state.docs.lock().unwrap();
        let doc = docs.get(&file_id).unwrap();

        let hash_before = blake3::hash(doc.rope.to_string().as_bytes());

        // Multiple viewport reads
        for start in [0, 1, 2, 3] {
            let sc = doc.rope.line_to_char(start);
            let ec = doc.rope.line_to_char((start + 2).min(doc.rope.len_lines()));
            let _ = doc.rope.slice(sc..ec).to_string();
        }

        let hash_after = blake3::hash(doc.rope.to_string().as_bytes());
        assert_eq!(hash_before, hash_after);
    }
}
