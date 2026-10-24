//! Snippet-template files — per-project `.md` files with YAML front-matter
//! that the right-hand Template panel reads, inserts at the caret, or stamps
//! into a new file. Distinct from `template.rs` (whole-project scaffolds).
//!
//! Storage:
//!   * bundled (read-only):   `<resource_dir>/bundled-templates/*.md`
//!   * project  (user-owned): `<project>/.novelist/templates/*.md`
//!
//! File format: YAML front-matter (string values only) + markdown body.
//!   ---
//!   name: 人物设定
//!   mode: new-file            # "insert" | "new-file"
//!   description: …            # optional
//!   defaultFilename: 人物设定.md  # only for new-file
//!   ---
//!   <body…>

use crate::error::AppError;
use crate::services::atomic_file::atomic_write_sync;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tempfile::TempPath;

const MAX_ID_LEN: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum TemplateSource {
    Bundled,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum TemplateMode {
    Insert,
    NewFile,
}

impl TemplateMode {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "insert" => Some(Self::Insert),
            "new-file" => Some(Self::NewFile),
            _ => None,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Insert => "insert",
            Self::NewFile => "new-file",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFileSummary {
    pub id: String,
    pub source: TemplateSource,
    pub name: String,
    pub mode: TemplateMode,
    pub description: Option<String>,
    pub default_filename: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFile {
    pub summary: TemplateFileSummary,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFrontMatterInput {
    pub name: String,
    pub mode: TemplateMode,
    pub description: Option<String>,
    pub default_filename: Option<String>,
}

// ---------------------------------------------------------------------------
// ID validation
// ---------------------------------------------------------------------------

fn validate_id(id: &str) -> Result<(), AppError> {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return Err(AppError::InvalidInput(format!(
            "template id must be 1..={MAX_ID_LEN} chars: {id}"
        )));
    }
    let mut chars = id.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() || first.is_ascii_uppercase() {
        return Err(AppError::InvalidInput(format!(
            "template id must start with lowercase letter or digit: {id}"
        )));
    }
    for c in chars {
        if !(c.is_ascii_digit() || (c.is_ascii_lowercase()) || c == '-') {
            return Err(AppError::InvalidInput(format!(
                "template id: illegal character {c:?} in {id}"
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Front-matter parser (YAML subset — string values only)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ParsedTemplate {
    pub front_matter: BTreeMap<String, String>,
    pub body: String,
}

/// Parse a template file's raw contents into front-matter + body.
///
/// * First non-empty, non-BOM line must be `---`.
/// * Subsequent lines are `key: value` until the next standalone `---`.
/// * Values may be quoted (`"..."`) with `\\`, `\"`, `\n` escapes.
/// * Unknown keys are kept verbatim (so we round-trip cleanly).
pub fn parse_template(raw: &str) -> Result<ParsedTemplate, AppError> {
    let raw = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    let mut lines = raw.split_inclusive('\n');

    // Open fence
    let first = lines
        .next()
        .ok_or_else(|| AppError::InvalidInput("template is empty (no front-matter)".into()))?;
    if first.trim_end_matches(['\n', '\r']) != "---" {
        return Err(AppError::InvalidInput(
            "template must start with --- (YAML front-matter fence)".into(),
        ));
    }

    let mut fm = BTreeMap::new();
    let mut body_start: Option<usize> = None;
    let mut consumed = first.len();
    for line in lines.by_ref() {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        consumed += line.len();
        if trimmed == "---" {
            body_start = Some(consumed);
            break;
        }
        if trimmed.is_empty() {
            continue;
        }
        if let Some(colon) = trimmed.find(':') {
            let key = trimmed[..colon].trim().to_string();
            let value_raw = trimmed[colon + 1..].trim();
            let value = parse_scalar(value_raw)?;
            if !key.is_empty() {
                fm.insert(key, value);
            }
        }
    }
    let body_start = body_start.ok_or_else(|| {
        AppError::InvalidInput("template is missing the closing --- fence".into())
    })?;
    let body = raw[body_start..].to_string();
    Ok(ParsedTemplate {
        front_matter: fm,
        body,
    })
}

fn parse_scalar(raw: &str) -> Result<String, AppError> {
    let raw = raw.trim();
    if raw.starts_with('"') {
        if !raw.ends_with('"') || raw.len() < 2 {
            return Err(AppError::InvalidInput(format!(
                "front-matter string not terminated: {raw}"
            )));
        }
        let inner = &raw[1..raw.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some(other) => {
                        out.push('\\');
                        out.push(other);
                    }
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        Ok(out)
    } else {
        Ok(raw.to_string())
    }
}

fn needs_quoting(value: &str) -> bool {
    value.is_empty()
        || value.starts_with(' ')
        || value.ends_with(' ')
        || value.starts_with('"')
        || value.starts_with('\'')
        || value.starts_with('#')
        || value.starts_with('-')
        || value.starts_with('&')
        || value.starts_with('*')
        || value.contains('\n')
        || value.contains(':')
        || value.contains('"')
}

fn emit_scalar(value: &str) -> String {
    if !needs_quoting(value) {
        return value.to_string();
    }
    let mut s = String::with_capacity(value.len() + 2);
    s.push('"');
    for c in value.chars() {
        match c {
            '\\' => s.push_str("\\\\"),
            '"' => s.push_str("\\\""),
            '\n' => s.push_str("\\n"),
            _ => s.push(c),
        }
    }
    s.push('"');
    s
}

/// Reassemble a template file from parsed front-matter + body.
pub fn format_template(fm: &BTreeMap<String, String>, body: &str) -> String {
    // Emit known keys in a stable order, then any extras alphabetically.
    const CANONICAL_ORDER: &[&str] = &["name", "mode", "description", "defaultFilename"];
    let mut out = String::from("---\n");
    for key in CANONICAL_ORDER {
        if let Some(v) = fm.get(*key) {
            out.push_str(&format!("{key}: {}\n", emit_scalar(v)));
        }
    }
    for (k, v) in fm.iter() {
        if CANONICAL_ORDER.iter().any(|c| c == k) {
            continue;
        }
        out.push_str(&format!("{k}: {}\n", emit_scalar(v)));
    }
    out.push_str("---\n");
    out.push_str(body);
    out
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn project_templates_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(".novelist").join("templates")
}

fn bundled_templates_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| AppError::Custom(format!("resource_dir: {e}")))?;
    Ok(resource_dir.join("bundled-templates"))
}

fn validate_project_dir(project_dir: &Path) -> Result<(), AppError> {
    if !project_dir.exists() {
        return Err(AppError::FileNotFound(format!(
            "project dir does not exist: {}",
            project_dir.display()
        )));
    }
    if !project_dir.is_dir() {
        return Err(AppError::NotADirectory(project_dir.display().to_string()));
    }
    Ok(())
}

async fn ensure_project_templates_dir(project_dir: &Path) -> Result<PathBuf, AppError> {
    let dir = project_templates_dir(project_dir);
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

/// Stage complete, durable bytes in an exclusively created sibling file.
/// The owned path removes the staging file on every failed write or publish.
fn stage_template_bytes(parent: &Path, bytes: &[u8]) -> Result<TempPath, AppError> {
    let mut builder = tempfile::Builder::new();
    builder
        .prefix(".novelist-template-")
        .suffix(".novelist-tmp");
    // tempfile stages 0600 by default and persisting keeps that mode; ask for
    // the normal 0666 (minus umask) so published files match other new files.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o666));
    }
    let mut temporary = builder.tempfile_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    Ok(temporary.into_temp_path())
}

fn summary_from_parsed(
    id: &str,
    source: TemplateSource,
    parsed: &ParsedTemplate,
) -> Result<TemplateFileSummary, AppError> {
    let name = parsed
        .front_matter
        .get("name")
        .cloned()
        .unwrap_or_else(|| id.to_string());
    let mode_raw = parsed
        .front_matter
        .get("mode")
        .map(|s| s.as_str())
        .unwrap_or("");
    let mode = TemplateMode::from_str(mode_raw).ok_or_else(|| {
        AppError::InvalidInput(format!(
            "template {id}: unknown mode {mode_raw:?} (expected 'insert' or 'new-file')"
        ))
    })?;
    let description = parsed
        .front_matter
        .get("description")
        .filter(|s| !s.is_empty())
        .cloned();
    let default_filename = parsed
        .front_matter
        .get("defaultFilename")
        .filter(|s| !s.is_empty())
        .cloned();
    if matches!(mode, TemplateMode::NewFile) && default_filename.is_none() {
        return Err(AppError::InvalidInput(format!(
            "template {id}: mode new-file requires a defaultFilename"
        )));
    }
    Ok(TemplateFileSummary {
        id: id.to_string(),
        source,
        name,
        mode,
        description,
        default_filename,
    })
}

async fn read_one(path: &Path, id: &str, source: TemplateSource) -> Result<TemplateFile, AppError> {
    let raw = tokio::fs::read_to_string(path).await?;
    let parsed = parse_template(&raw)?;
    let summary = summary_from_parsed(id, source, &parsed)?;
    Ok(TemplateFile {
        summary,
        body: parsed.body,
    })
}

fn id_from_path(path: &Path) -> Option<String> {
    path.file_stem().map(|s| s.to_string_lossy().to_string())
}

async fn list_in_dir(
    dir: &Path,
    source: TemplateSource,
) -> Result<Vec<TemplateFileSummary>, AppError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(id) = id_from_path(&p) else { continue };
        if validate_id(&id).is_err() {
            // Skip files whose stem isn't a legal id rather than failing the whole list.
            continue;
        }
        let raw = match tokio::fs::read_to_string(&p).await {
            Ok(s) => s,
            Err(_) => continue,
        };
        let parsed = match parse_template(&raw) {
            Ok(x) => x,
            Err(_) => continue,
        };
        if let Ok(summary) = summary_from_parsed(&id, source, &parsed) {
            out.push(summary);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn list_template_files(
    app_handle: tauri::AppHandle,
    project_dir: Option<String>,
) -> Result<Vec<TemplateFileSummary>, AppError> {
    let mut result: Vec<TemplateFileSummary> = Vec::new();

    // Bundled
    let bundled_dir = bundled_templates_dir(&app_handle)?;
    let mut bundled = list_in_dir(&bundled_dir, TemplateSource::Bundled).await?;
    bundled.sort_by(|a, b| a.name.cmp(&b.name));

    // Project (project overrides bundled if IDs clash)
    let mut project: Vec<TemplateFileSummary> = Vec::new();
    if let Some(pd) = project_dir.as_deref() {
        let pd = Path::new(pd);
        if pd.exists() && pd.is_dir() {
            let dir = project_templates_dir(pd);
            project = list_in_dir(&dir, TemplateSource::Project).await?;
            project.sort_by(|a, b| a.name.cmp(&b.name));
        }
    }

    let project_ids: std::collections::HashSet<&str> =
        project.iter().map(|s| s.id.as_str()).collect();

    for b in bundled.into_iter() {
        if !project_ids.contains(b.id.as_str()) {
            result.push(b);
        }
    }
    for p in project.into_iter() {
        result.push(p);
    }
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn read_template_file(
    app_handle: tauri::AppHandle,
    source: TemplateSource,
    id: String,
    project_dir: Option<String>,
) -> Result<TemplateFile, AppError> {
    validate_id(&id)?;
    match source {
        TemplateSource::Bundled => {
            let dir = bundled_templates_dir(&app_handle)?;
            let path = dir.join(format!("{id}.md"));
            if !path.exists() {
                return Err(AppError::FileNotFound(format!("bundled template {id}")));
            }
            read_one(&path, &id, TemplateSource::Bundled).await
        }
        TemplateSource::Project => {
            let pd = project_dir.ok_or_else(|| {
                AppError::InvalidInput("project_dir required for project templates".into())
            })?;
            let pd = PathBuf::from(pd);
            validate_project_dir(&pd)?;
            let path = project_templates_dir(&pd).join(format!("{id}.md"));
            if !path.exists() {
                return Err(AppError::FileNotFound(format!("project template {id}.md")));
            }
            read_one(&path, &id, TemplateSource::Project).await
        }
    }
}

fn front_matter_from_input(input: &TemplateFrontMatterInput) -> BTreeMap<String, String> {
    let mut fm = BTreeMap::new();
    fm.insert("name".to_string(), input.name.clone());
    fm.insert("mode".to_string(), input.mode.as_str().to_string());
    if let Some(d) = &input.description {
        if !d.is_empty() {
            fm.insert("description".to_string(), d.clone());
        }
    }
    if let Some(f) = &input.default_filename {
        if !f.is_empty() {
            fm.insert("defaultFilename".to_string(), f.clone());
        }
    }
    fm
}

#[tauri::command]
#[specta::specta]
pub async fn write_template_file(
    project_dir: String,
    id: String,
    front_matter: TemplateFrontMatterInput,
    body: String,
) -> Result<TemplateFileSummary, AppError> {
    validate_id(&id)?;
    let pd = PathBuf::from(&project_dir);
    validate_project_dir(&pd)?;
    if front_matter.name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "template name must not be empty".into(),
        ));
    }
    if matches!(front_matter.mode, TemplateMode::NewFile) {
        let empty = front_matter
            .default_filename
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if empty {
            return Err(AppError::InvalidInput(
                "new-file mode requires a non-empty defaultFilename".into(),
            ));
        }
    }

    let dir = ensure_project_templates_dir(&pd).await?;
    let target = dir.join(format!("{id}.md"));
    let fm = front_matter_from_input(&front_matter);
    let content = format_template(&fm, &body);

    let content = tokio::task::spawn_blocking(move || -> Result<String, AppError> {
        atomic_write_sync(&target, content.as_bytes())?;
        Ok(content)
    })
    .await
    .map_err(|error| AppError::Custom(format!("write template task: {error}")))??;

    let parsed = parse_template(&content)?;
    summary_from_parsed(&id, TemplateSource::Project, &parsed)
}

#[tauri::command]
#[specta::specta]
pub async fn rename_template_file(
    project_dir: String,
    old_id: String,
    new_id: String,
) -> Result<TemplateFileSummary, AppError> {
    validate_id(&old_id)?;
    validate_id(&new_id)?;
    if old_id == new_id {
        return Err(AppError::InvalidInput(
            "new id equals old id; nothing to rename".into(),
        ));
    }
    let pd = PathBuf::from(&project_dir);
    validate_project_dir(&pd)?;
    let dir = project_templates_dir(&pd);
    let src = dir.join(format!("{old_id}.md"));
    let dst = dir.join(format!("{new_id}.md"));
    if !src.exists() {
        return Err(AppError::FileNotFound(format!("template {old_id}.md")));
    }
    if dst.exists() {
        return Err(AppError::InvalidInput(format!(
            "template {new_id}.md already exists"
        )));
    }
    tokio::fs::rename(&src, &dst).await?;
    let raw = tokio::fs::read_to_string(&dst).await?;
    let parsed = parse_template(&raw)?;
    summary_from_parsed(&new_id, TemplateSource::Project, &parsed)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_template_file(project_dir: String, id: String) -> Result<(), AppError> {
    validate_id(&id)?;
    let pd = PathBuf::from(&project_dir);
    validate_project_dir(&pd)?;
    let path = project_templates_dir(&pd).join(format!("{id}.md"));
    if !path.exists() {
        return Err(AppError::FileNotFound(format!("template {id}.md")));
    }
    tokio::fs::remove_file(&path).await?;
    Ok(())
}

fn duplicate_template_into_project(
    dir: &Path,
    bundled_id: &str,
    new_id: Option<&str>,
    raw: &str,
) -> Result<TemplateFileSummary, AppError> {
    if let Some(explicit) = new_id {
        validate_id(explicit)?;
    }
    let parsed = parse_template(raw)?;
    let mut temporary = stage_template_bytes(dir, raw.as_bytes())?;
    let mut final_id = new_id.unwrap_or(bundled_id).to_string();
    let mut n = 2u32;
    loop {
        let target = dir.join(format!("{final_id}.md"));
        match temporary.persist_noclobber(&target) {
            Ok(()) => return summary_from_parsed(&final_id, TemplateSource::Project, &parsed),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temporary = error.path;
                if new_id.is_some() {
                    return Err(AppError::InvalidInput(format!(
                        "template {final_id}.md already exists"
                    )));
                }
                final_id = format!("{bundled_id}-{n}");
                n += 1;
                if n > 999 {
                    return Err(AppError::Custom(
                        "too many existing copies of this template".into(),
                    ));
                }
            }
            Err(error) => return Err(error.error.into()),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn duplicate_bundled_template(
    app_handle: tauri::AppHandle,
    project_dir: String,
    bundled_id: String,
    new_id: Option<String>,
) -> Result<TemplateFileSummary, AppError> {
    validate_id(&bundled_id)?;
    let pd = PathBuf::from(&project_dir);
    validate_project_dir(&pd)?;

    let bundled_dir = bundled_templates_dir(&app_handle)?;
    let src_path = bundled_dir.join(format!("{bundled_id}.md"));
    if !src_path.exists() {
        return Err(AppError::FileNotFound(format!(
            "bundled template {bundled_id}"
        )));
    }
    let raw = tokio::fs::read_to_string(&src_path).await?;

    let dir = ensure_project_templates_dir(&pd).await?;
    tokio::task::spawn_blocking(move || {
        duplicate_template_into_project(&dir, &bundled_id, new_id.as_deref(), &raw)
    })
    .await
    .map_err(|error| AppError::Custom(format!("duplicate template task: {error}")))?
}

/// Create a new file in `dir` with `body`. If `filename` already exists,
/// auto-bump `stem 2.ext`, `stem 3.ext`, … just like the existing file-tree
/// "New file" flow. Returns the resolved absolute path. Used by new-file-mode
/// template execution so the frontend does not need to orchestrate sanitize +
/// bump + write itself.
#[tauri::command]
#[specta::specta]
pub async fn create_file_with_body(
    dir: String,
    filename: String,
    body: String,
) -> Result<String, AppError> {
    if filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.contains('\0')
        || filename.trim().is_empty()
    {
        return Err(AppError::InvalidInput(format!("bad filename: {filename}")));
    }
    let parent = PathBuf::from(&dir);
    if !parent.exists() {
        return Err(AppError::FileNotFound(format!(
            "parent dir does not exist: {}",
            parent.display()
        )));
    }
    if !parent.is_dir() {
        return Err(AppError::NotADirectory(parent.display().to_string()));
    }

    tokio::task::spawn_blocking(move || {
        let p = Path::new(&filename);
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy())
            .unwrap_or_default();
        let ext = p
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();

        let mut temporary = stage_template_bytes(&parent, body.as_bytes())?;
        let mut target = parent.join(&filename);
        let mut n = 2u32;
        loop {
            // Publication itself decides collisions, including concurrent creates
            // and dangling symlinks; no prior exists() check can reserve a name.
            match temporary.persist_noclobber(&target) {
                Ok(()) => return Ok(target.to_string_lossy().to_string()),
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    temporary = error.path;
                    target = parent.join(format!("{stem} {n}{ext}"));
                    n += 1;
                    if n > 9999 {
                        return Err(AppError::Custom("collision counter overflowed".into()));
                    }
                }
                Err(error) => return Err(error.error.into()),
            }
        }
    })
    .await
    .map_err(|error| AppError::Custom(format!("create template file task: {error}")))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_project() -> TempDir {
        TempDir::new().unwrap()
    }

    #[test]
    fn parse_simple_front_matter() {
        let raw = "---\nname: 测试\nmode: insert\n---\n# Body\n";
        let p = parse_template(raw).unwrap();
        assert_eq!(p.front_matter.get("name").unwrap(), "测试");
        assert_eq!(p.front_matter.get("mode").unwrap(), "insert");
        assert_eq!(p.body, "# Body\n");
    }

    #[test]
    fn parse_quoted_with_escapes() {
        let raw = "---\nname: \"a \\\"b\\\" c\"\nmode: insert\n---\nbody";
        let p = parse_template(raw).unwrap();
        assert_eq!(p.front_matter.get("name").unwrap(), "a \"b\" c");
    }

    #[test]
    fn parse_preserves_unknown_keys() {
        let raw = "---\nname: n\nmode: insert\nfuture: x\n---\n";
        let p = parse_template(raw).unwrap();
        assert_eq!(p.front_matter.get("future").unwrap(), "x");
    }

    #[test]
    fn parse_bom_tolerated() {
        let raw = "\u{FEFF}---\nname: n\nmode: insert\n---\nbody";
        let p = parse_template(raw).unwrap();
        assert_eq!(p.front_matter.get("name").unwrap(), "n");
    }

    #[test]
    fn parse_missing_close_fence_errors() {
        let raw = "---\nname: n\nmode: insert\n# no close\n";
        assert!(parse_template(raw).is_err());
    }

    #[test]
    fn parse_missing_open_fence_errors() {
        let raw = "name: n\nmode: insert\n";
        assert!(parse_template(raw).is_err());
    }

    #[test]
    fn round_trip_format_parse() {
        let mut fm = BTreeMap::new();
        fm.insert("name".into(), "大纲".into());
        fm.insert("mode".into(), "new-file".into());
        fm.insert("defaultFilename".into(), "大纲.md".into());
        let body = "# title\n\ncontent\n";
        let s = format_template(&fm, body);
        let p = parse_template(&s).unwrap();
        assert_eq!(p.front_matter.get("name").unwrap(), "大纲");
        assert_eq!(p.front_matter.get("mode").unwrap(), "new-file");
        assert_eq!(p.front_matter.get("defaultFilename").unwrap(), "大纲.md");
        assert_eq!(p.body, body);
    }

    #[test]
    fn format_quotes_when_needed() {
        let mut fm = BTreeMap::new();
        fm.insert("name".into(), "weird: value".into());
        fm.insert("mode".into(), "insert".into());
        let s = format_template(&fm, "");
        assert!(s.contains("name: \"weird: value\""));
    }

    #[test]
    fn validate_id_rules() {
        assert!(validate_id("outline").is_ok());
        assert!(validate_id("chapter-skeleton").is_ok());
        assert!(validate_id("0x1-abc").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("Outline").is_err());
        assert!(validate_id("has space").is_err());
        assert!(validate_id("has.dot").is_err());
        assert!(validate_id("has/slash").is_err());
        assert!(validate_id(&"x".repeat(MAX_ID_LEN + 1)).is_err());
    }

    #[test]
    fn summary_new_file_requires_default_filename() {
        let p = ParsedTemplate {
            front_matter: {
                let mut m = BTreeMap::new();
                m.insert("name".into(), "x".into());
                m.insert("mode".into(), "new-file".into());
                m
            },
            body: String::new(),
        };
        assert!(summary_from_parsed("t", TemplateSource::Project, &p).is_err());
    }

    #[test]
    fn summary_insert_mode_ok_without_filename() {
        let p = ParsedTemplate {
            front_matter: {
                let mut m = BTreeMap::new();
                m.insert("name".into(), "x".into());
                m.insert("mode".into(), "insert".into());
                m
            },
            body: String::new(),
        };
        let s = summary_from_parsed("t", TemplateSource::Project, &p).unwrap();
        assert_eq!(s.mode, TemplateMode::Insert);
        assert_eq!(s.default_filename, None);
    }

    // -- Tokio-based command tests (project commands don't need AppHandle) --

    #[tokio::test]
    async fn write_then_rename_then_delete() {
        let td = make_project();
        let pd = td.path().to_string_lossy().to_string();
        let fm = TemplateFrontMatterInput {
            name: "scene".into(),
            mode: TemplateMode::Insert,
            description: Some("tiny".into()),
            default_filename: None,
        };
        let summary = write_template_file(pd.clone(), "scene".into(), fm, "body\n".into())
            .await
            .unwrap();
        assert_eq!(summary.id, "scene");
        assert_eq!(summary.source, TemplateSource::Project);

        // rename
        let summary = rename_template_file(pd.clone(), "scene".into(), "scene-v2".into())
            .await
            .unwrap();
        assert_eq!(summary.id, "scene-v2");

        // rename again to same id should fail
        let err = rename_template_file(pd.clone(), "scene-v2".into(), "scene-v2".into()).await;
        assert!(err.is_err());

        // delete
        delete_template_file(pd.clone(), "scene-v2".into())
            .await
            .unwrap();
        assert!(delete_template_file(pd.clone(), "scene-v2".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn new_file_mode_requires_filename() {
        let td = make_project();
        let pd = td.path().to_string_lossy().to_string();
        let fm = TemplateFrontMatterInput {
            name: "x".into(),
            mode: TemplateMode::NewFile,
            description: None,
            default_filename: None,
        };
        let err = write_template_file(pd, "x".into(), fm, "body".into()).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn write_creates_dotnovelist_templates_dir() {
        let td = make_project();
        let pd_path = td.path().to_path_buf();
        let pd = pd_path.to_string_lossy().to_string();
        let fm = TemplateFrontMatterInput {
            name: "x".into(),
            mode: TemplateMode::Insert,
            description: None,
            default_filename: None,
        };
        write_template_file(pd, "x".into(), fm, "body".into())
            .await
            .unwrap();
        assert!(pd_path
            .join(".novelist")
            .join("templates")
            .join("x.md")
            .exists());
    }

    #[tokio::test]
    async fn write_template_preserves_existing_temporary_files() {
        let td = make_project();
        let dir = project_templates_dir(td.path());
        std::fs::create_dir_all(&dir).unwrap();
        let old_temp = dir.join("scene.md.novelist-tmp");
        std::fs::write(&old_temp, "unrelated temporary data").unwrap();
        for body in ["first body", "replacement body"] {
            let front_matter = TemplateFrontMatterInput {
                name: "scene".into(),
                mode: TemplateMode::Insert,
                description: None,
                default_filename: None,
            };
            write_template_file(
                td.path().to_string_lossy().to_string(),
                "scene".into(),
                front_matter,
                body.into(),
            )
            .await
            .unwrap();
            let saved = read_one(&dir.join("scene.md"), "scene", TemplateSource::Project)
                .await
                .unwrap();
            assert_eq!(saved.body, body);
            assert_eq!(
                std::fs::read_to_string(&old_temp).unwrap(),
                "unrelated temporary data"
            );
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        }
    }

    #[test]
    fn duplicate_template_preserves_targets_and_temporary_files() {
        let td = make_project();
        let old_temp = td.path().join("scene.md.novelist-tmp");
        std::fs::write(&old_temp, "unrelated temporary data").unwrap();
        let original = "---\nname: scene\nmode: insert\n---\noriginal body";
        let replacement = "---\nname: scene\nmode: insert\n---\nreplacement body";
        let first = duplicate_template_into_project(td.path(), "scene", None, original).unwrap();
        assert_eq!(first.id, "scene");
        let collision =
            duplicate_template_into_project(td.path(), "scene", Some("scene"), replacement);
        assert!(matches!(collision, Err(AppError::InvalidInput(_))));
        assert_eq!(
            std::fs::read_to_string(td.path().join("scene.md")).unwrap(),
            original
        );
        assert_eq!(std::fs::read_dir(td.path()).unwrap().count(), 2);
        let second =
            duplicate_template_into_project(td.path(), "scene", None, replacement).unwrap();
        assert_eq!(second.id, "scene-2");
        assert_eq!(
            std::fs::read_to_string(td.path().join("scene-2.md")).unwrap(),
            replacement
        );
        assert_eq!(
            std::fs::read_to_string(old_temp).unwrap(),
            "unrelated temporary data"
        );
        assert_eq!(std::fs::read_dir(td.path()).unwrap().count(), 3);
    }

    #[tokio::test]
    async fn duplicate_template_concurrently_keeps_each_body() {
        let td = make_project();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(12));
        let mut copies = tokio::task::JoinSet::new();
        for index in 0..12 {
            let dir = td.path().to_path_buf();
            let barrier = barrier.clone();
            copies.spawn_blocking(move || {
                let raw = format!("---\nname: scene\nmode: insert\n---\nbody {index}");
                barrier.wait();
                let summary = duplicate_template_into_project(&dir, "scene", None, &raw).unwrap();
                (summary.id, raw)
            });
        }
        let mut ids = std::collections::BTreeSet::new();
        while let Some(result) = copies.join_next().await {
            let (id, raw) = result.unwrap();
            assert!(ids.insert(id.clone()));
            assert_eq!(
                std::fs::read_to_string(td.path().join(format!("{id}.md"))).unwrap(),
                raw
            );
        }
        assert_eq!(ids.len(), 12);
        assert_eq!(std::fs::read_dir(td.path()).unwrap().count(), 12);
    }

    #[tokio::test]
    async fn create_file_with_body_bumps_collision() {
        let td = make_project();
        let dir = td.path().to_string_lossy().to_string();
        let a = create_file_with_body(dir.clone(), "note.md".into(), "A".into())
            .await
            .unwrap();
        let b = create_file_with_body(dir.clone(), "note.md".into(), "B".into())
            .await
            .unwrap();
        assert_ne!(a, b);
        assert!(b.contains("note 2.md"));
        assert_eq!(std::fs::read_to_string(a).unwrap(), "A");
        assert_eq!(std::fs::read_to_string(b).unwrap(), "B");
        assert_eq!(std::fs::read_dir(td.path()).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn create_file_with_body_preserves_existing_temporary_files() {
        let td = make_project();
        let existing = [
            "chapter.novelist-tmp",
            "chapter.md.novelist-tmp",
            ".novelist-template-existing.novelist-tmp",
        ];
        for filename in existing {
            std::fs::write(td.path().join(filename), filename).unwrap();
        }
        let path = create_file_with_body(
            td.path().to_string_lossy().to_string(),
            "chapter.md".into(),
            "new chapter body".into(),
        )
        .await
        .unwrap();
        assert_eq!(Path::new(&path), td.path().join("chapter.md"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "new chapter body");
        for filename in existing {
            assert_eq!(
                std::fs::read_to_string(td.path().join(filename)).unwrap(),
                filename
            );
        }
        assert_eq!(std::fs::read_dir(td.path()).unwrap().count(), 4);
    }

    #[tokio::test]
    async fn create_file_with_body_concurrently_keeps_each_body() {
        let td = make_project();
        std::fs::write(td.path().join("chapter.md"), "existing chapter").unwrap();
        std::fs::write(td.path().join("chapter.novelist-tmp"), "existing temporary").unwrap();
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(16));
        let mut creates = tokio::task::JoinSet::new();
        for index in 0..16 {
            let dir = td.path().to_string_lossy().to_string();
            let barrier = barrier.clone();
            creates.spawn(async move {
                let body = format!("chapter body {index}");
                barrier.wait().await;
                let path = create_file_with_body(dir, "chapter.md".into(), body.clone())
                    .await
                    .unwrap();
                (path, body)
            });
        }
        let mut paths = std::collections::BTreeSet::new();
        while let Some(result) = creates.join_next().await {
            let (path, body) = result.unwrap();
            assert!(paths.insert(path.clone()));
            assert_eq!(std::fs::read_to_string(path).unwrap(), body);
        }
        assert_eq!(paths.len(), 16);
        assert_eq!(
            std::fs::read_to_string(td.path().join("chapter.md")).unwrap(),
            "existing chapter"
        );
        assert_eq!(
            std::fs::read_to_string(td.path().join("chapter.novelist-tmp")).unwrap(),
            "existing temporary"
        );
        assert_eq!(std::fs::read_dir(td.path()).unwrap().count(), 18);
    }

    #[tokio::test]
    async fn create_file_with_body_cleans_staging_after_publish_failure() {
        let td = make_project();
        let existing = td.path().join("chapter.novelist-tmp");
        std::fs::write(&existing, "unrelated temporary data").unwrap();
        // This exceeds supported filesystem component limits, but staging uses
        // its own short sibling name and succeeds before publication fails.
        let result = create_file_with_body(
            td.path().to_string_lossy().to_string(),
            "x".repeat(40_000),
            "body that must not leak".into(),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(existing).unwrap(),
            "unrelated temporary data"
        );
        assert_eq!(std::fs::read_dir(td.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_file_with_body_keeps_dangling_symlink_targets() {
        let td = make_project();
        let existing = td.path().join("chapter.md");
        std::os::unix::fs::symlink("missing.md", &existing).unwrap();
        let path = create_file_with_body(
            td.path().to_string_lossy().to_string(),
            "chapter.md".into(),
            "new chapter".into(),
        )
        .await
        .unwrap();
        assert_eq!(Path::new(&path), td.path().join("chapter 2.md"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "new chapter");
        assert_eq!(
            std::fs::read_link(existing).unwrap(),
            Path::new("missing.md")
        );
        assert_eq!(std::fs::read_dir(td.path()).unwrap().count(), 2);
    }

    /// Staged files are created 0600 by tempfile; published template files
    /// must instead get the same umask-derived mode as any other new file.
    #[cfg(unix)]
    #[tokio::test]
    async fn template_created_files_get_the_normal_new_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let td = make_project();
        let plain = td.path().join("plain.md");
        std::fs::File::create(&plain).unwrap();
        let expected = mode(&plain);

        let created = create_file_with_body(
            td.path().to_string_lossy().to_string(),
            "第一章.md".into(),
            "正文".into(),
        )
        .await
        .unwrap();
        let duplicated = duplicate_template_into_project(
            td.path(),
            "scene",
            None,
            "---\nname: scene\nmode: insert\n---\nbody",
        )
        .unwrap();

        assert_eq!(mode(Path::new(&created)), expected, "{expected:o}");
        assert_eq!(
            mode(&td.path().join(format!("{}.md", duplicated.id))),
            expected,
            "{expected:o}"
        );
    }

    #[tokio::test]
    async fn rename_rejects_collision() {
        let td = make_project();
        let pd = td.path().to_string_lossy().to_string();
        for id in &["a", "b"] {
            let fm = TemplateFrontMatterInput {
                name: "n".into(),
                mode: TemplateMode::Insert,
                description: None,
                default_filename: None,
            };
            write_template_file(pd.clone(), (*id).into(), fm, "body".into())
                .await
                .unwrap();
        }
        let err = rename_template_file(pd.clone(), "a".into(), "b".into()).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn delete_unknown_is_error() {
        let td = make_project();
        let pd = td.path().to_string_lossy().to_string();
        let err = delete_template_file(pd, "ghost".into()).await;
        assert!(err.is_err());
    }
}
