use crate::commands::file::decode_bytes;
use crate::error::AppError;
use crate::models::project::{OutlineConfig, ProjectConfig, ProjectMeta, WritingConfig};
use crate::models::settings::PluginsConfig;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use zip::ZipArchive;

const MAX_EPUB_ENTRIES: usize = 4096;
const MAX_EPUB_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
const LITERARY_PLUGIN_ID: &str = "literary-commentary";
const LITERARY_CONTENT_ROOT: &str = "学习内容";
const LITERARY_METADATA_FILE: &str = "literary-study.json";
const LITERARY_SCHEMA_VERSION: u32 = 2;
const MAX_LITERARY_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LITERARY_CHAPTER_BYTES: u64 = 32 * 1024 * 1024;
const MAX_LITERARY_CHAPTERS: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiteraryChapterDraft {
    pub id: String,
    pub volume: Option<String>,
    pub title: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiterarySourceInspection {
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
    pub source_path: String,
    pub chapters: Vec<LiteraryChapterDraft>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateLiteraryStudyProjectRequest {
    pub project_name: String,
    pub parent_dir: String,
    pub source_path: String,
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
    pub chapters: Vec<LiteraryChapterDraft>,
}

#[derive(Debug, Clone, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateLiteraryStudyProjectResult {
    pub project_path: String,
    pub first_chapter_path: String,
    pub chapter_count: usize,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceLiteraryStudyBookRequest {
    pub project_dir: String,
    pub source_path: String,
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
    pub chapters: Vec<LiteraryChapterDraft>,
}

#[derive(Debug, Clone, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceLiteraryStudyBookResult {
    pub first_chapter_path: String,
    pub resume_chapter_path: String,
    pub chapter_count: usize,
    pub preserved_chapter_count: usize,
}

#[derive(Debug, Clone, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiteraryChapterSummary {
    pub id: String,
    pub title: String,
    pub volume: Option<String>,
    pub index: usize,
    pub total: usize,
    pub relative_path: String,
    pub source_characters: usize,
    pub copied_characters: usize,
    pub mistakes: usize,
    pub pasted: usize,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiteraryStudyOverview {
    pub schema_version: u32,
    pub source_path: String,
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
    pub chapter_count: usize,
    pub completed_chapters: usize,
    pub copied_characters: usize,
    pub total_characters: usize,
    pub mistakes: usize,
    pub pasted: usize,
    pub resume_chapter_path: Option<String>,
    pub chapters: Vec<LiteraryChapterSummary>,
}

#[derive(Debug, Clone)]
struct OpfItem {
    href: String,
    media_type: String,
    properties: String,
}

#[derive(Debug, Default)]
struct OpfData {
    title: String,
    author: Option<String>,
    language: Option<String>,
    manifest: HashMap<String, OpfItem>,
    spine: Vec<String>,
    toc_id: Option<String>,
}

#[derive(Debug, Clone)]
struct NavLabel {
    title: String,
    volume: Option<String>,
}

#[derive(Debug, Default)]
struct NavPoint {
    label: String,
    src: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryProjectMetadata {
    schema_version: u32,
    source_path: String,
    title: String,
    author: Option<String>,
    language: Option<String>,
    chapter_count: usize,
    #[serde(default)]
    content_root: Option<String>,
    #[serde(default)]
    chapter_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryStudyFile {
    schema_version: u32,
    book: LiteraryBook,
    chapter: LiteraryChapter,
    source: String,
    source_cursor: usize,
    insertions: Vec<LiteraryInsertion>,
    stats: LiteraryStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryBook {
    title: String,
    author: Option<String>,
    language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryChapter {
    id: String,
    title: String,
    volume: Option<String>,
    index: usize,
    total: usize,
    previous_path: Option<String>,
    next_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryInsertion {
    id: String,
    source_offset: usize,
    order: usize,
    kind: String,
    text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryStats {
    correct: usize,
    mistakes: usize,
    pasted: usize,
    started_at: Option<String>,
    completed_at: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn inspect_literary_source(path: String) -> Result<LiterarySourceInspection, AppError> {
    tokio::task::spawn_blocking(move || inspect_literary_source_inner(&path))
        .await
        .map_err(|error| AppError::Custom(format!("Literary import task failed: {error}")))?
}

#[tauri::command]
#[specta::specta]
pub async fn create_literary_study_project(
    request: CreateLiteraryStudyProjectRequest,
) -> Result<CreateLiteraryStudyProjectResult, AppError> {
    tokio::task::spawn_blocking(move || create_literary_study_project_inner(request))
        .await
        .map_err(|error| AppError::Custom(format!("Literary project task failed: {error}")))?
}

#[tauri::command]
#[specta::specta]
pub async fn read_literary_study_overview(
    project_dir: String,
) -> Result<LiteraryStudyOverview, AppError> {
    tokio::task::spawn_blocking(move || read_literary_study_overview_inner(&project_dir))
        .await
        .map_err(|error| AppError::Custom(format!("Literary overview task failed: {error}")))?
}

#[tauri::command]
#[specta::specta]
pub async fn replace_literary_study_book(
    request: ReplaceLiteraryStudyBookRequest,
) -> Result<ReplaceLiteraryStudyBookResult, AppError> {
    tokio::task::spawn_blocking(move || replace_literary_study_book_inner(request))
        .await
        .map_err(|error| AppError::Custom(format!("Literary replacement task failed: {error}")))?
}

fn inspect_literary_source_inner(path: &str) -> Result<LiterarySourceInspection, AppError> {
    let source_path = PathBuf::from(path);
    if !source_path.is_file() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match extension.as_str() {
        "epub" => inspect_epub(&source_path),
        "txt" => inspect_txt(&source_path),
        _ => Err(AppError::InvalidInput(
            "Literary import supports EPUB and TXT files".to_string(),
        )),
    }
}

fn inspect_txt(path: &Path) -> Result<LiterarySourceInspection, AppError> {
    let bytes = std::fs::read(path)?;
    let (_, text) = decode_bytes(&bytes);
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported text")
        .to_string();

    Ok(LiterarySourceInspection {
        title,
        author: None,
        language: None,
        source_path: path.to_string_lossy().to_string(),
        chapters: split_txt_chapters(&text),
    })
}

fn split_txt_chapters(text: &str) -> Vec<LiteraryChapterDraft> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut chapters = Vec::new();
    let mut current_title = String::new();
    let mut current_lines: Vec<&str> = Vec::new();

    let flush =
        |chapters: &mut Vec<LiteraryChapterDraft>, title: &mut String, lines: &mut Vec<&str>| {
            let body = lines.join("\n").trim().to_string();
            if body.is_empty() {
                lines.clear();
                return;
            }
            let chapter_title = if title.is_empty() {
                if chapters.is_empty() {
                    "正文".to_string()
                } else {
                    format!("第{}节", chapters.len() + 1)
                }
            } else {
                title.clone()
            };
            chapters.push(LiteraryChapterDraft {
                id: format!("chapter-{:04}", chapters.len() + 1),
                volume: None,
                title: chapter_title,
                text: body,
            });
            title.clear();
            lines.clear();
        };

    for line in normalized.lines() {
        let trimmed = line.trim();
        if looks_like_chapter_heading(trimmed) {
            flush(&mut chapters, &mut current_title, &mut current_lines);
            current_title = trimmed.to_string();
        } else {
            current_lines.push(line);
        }
    }
    flush(&mut chapters, &mut current_title, &mut current_lines);

    if chapters.is_empty() && !normalized.trim().is_empty() {
        chapters.push(LiteraryChapterDraft {
            id: "chapter-0001".to_string(),
            volume: None,
            title: "正文".to_string(),
            text: normalized.trim().to_string(),
        });
    }
    chapters
}

fn looks_like_chapter_heading(line: &str) -> bool {
    if line.is_empty() || line.chars().count() > 80 {
        return false;
    }

    let compact = line.trim_matches(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '#' | '*' | '=' | '-' | '_' | '【' | '】' | '[' | ']'
            )
    });
    let lower = compact.to_ascii_lowercase();
    if lower == "prologue"
        || lower == "epilogue"
        || lower.starts_with("chapter ")
        || lower.starts_with("chapter\t")
    {
        return true;
    }

    if matches!(
        compact,
        "序" | "序章" | "楔子" | "引子" | "前言" | "后记" | "尾声"
    ) {
        return true;
    }

    if !compact.starts_with('第') {
        return false;
    }
    compact
        .chars()
        .skip(1)
        .take(24)
        .any(|character| matches!(character, '章' | '回' | '节' | '卷' | '篇' | '部'))
}

fn inspect_epub(path: &Path) -> Result<LiterarySourceInspection, AppError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| AppError::InvalidInput(format!("Invalid EPUB archive: {error}")))?;
    validate_epub_archive(&mut archive)?;

    let container = read_zip_text(&mut archive, "META-INF/container.xml")?;
    let opf_path = parse_container_rootfile(&container)?;
    let opf_xml = read_zip_text(&mut archive, &opf_path)?;
    let opf = parse_opf(&opf_xml)?;
    let opf_dir = Path::new(&opf_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));

    let nav_labels = load_navigation_labels(&mut archive, &opf, opf_dir)?;
    let mut chapters = Vec::new();

    for idref in &opf.spine {
        let Some(item) = opf.manifest.get(idref) else {
            continue;
        };
        if !is_document_item(item) {
            continue;
        }
        let item_path = resolve_archive_path(opf_dir, &item.href)?;
        let document = match read_zip_text(&mut archive, &item_path) {
            Ok(document) => document,
            Err(error) => {
                tracing::warn!(path = %item_path, error = %error, "skipping unreadable EPUB spine item");
                continue;
            }
        };
        let mut text = extract_xhtml_text(&document);
        if text.trim().is_empty() {
            continue;
        }

        let href_key = normalize_href(&item.href);
        let navigation = nav_labels.get(&href_key);
        let title = navigation
            .map(|value| value.title.clone())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| first_nonempty_line(&text))
            .unwrap_or_else(|| format!("第{}章", chapters.len() + 1));
        text = strip_repeated_heading(&text, &title);
        if text.trim().is_empty() {
            continue;
        }
        chapters.push(LiteraryChapterDraft {
            id: format!("chapter-{:04}", chapters.len() + 1),
            volume: navigation.and_then(|value| value.volume.clone()),
            title,
            text,
        });
    }

    if chapters.is_empty() {
        return Err(AppError::InvalidInput(
            "No readable text chapters were found in this EPUB".to_string(),
        ));
    }

    let fallback_title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported EPUB")
        .to_string();

    Ok(LiterarySourceInspection {
        title: if opf.title.trim().is_empty() {
            fallback_title
        } else {
            opf.title
        },
        author: opf.author,
        language: opf.language,
        source_path: path.to_string_lossy().to_string(),
        chapters,
    })
}

fn validate_epub_archive(archive: &mut ZipArchive<File>) -> Result<(), AppError> {
    if archive.len() > MAX_EPUB_ENTRIES {
        return Err(AppError::InvalidInput(format!(
            "EPUB contains too many files: {}",
            archive.len()
        )));
    }
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| AppError::InvalidInput(format!("Invalid EPUB entry: {error}")))?;
        if entry.enclosed_name().is_none() {
            return Err(AppError::InvalidInput(format!(
                "Unsafe EPUB path: {}",
                entry.name()
            )));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_EPUB_UNCOMPRESSED_BYTES {
            return Err(AppError::InvalidInput(
                "EPUB expands beyond the 512 MB safety limit".to_string(),
            ));
        }
    }
    Ok(())
}

fn read_zip_text(archive: &mut ZipArchive<File>, path: &str) -> Result<String, AppError> {
    let normalized = normalize_href(path);
    let mut entry = archive
        .by_name(&normalized)
        .map_err(|_| AppError::FileNotFound(format!("EPUB entry {normalized}")))?;
    let mut bytes = Vec::with_capacity(entry.size().min(4 * 1024 * 1024) as usize);
    entry.read_to_end(&mut bytes)?;
    let (_, text) = decode_bytes(&bytes);
    Ok(text)
}

fn parse_container_rootfile(xml: &str) -> Result<String, AppError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if local_name(element.name().as_ref()) == b"rootfile" =>
            {
                if let Some(path) = attribute_value(&reader, &element, b"full-path")? {
                    return Ok(normalize_href(&path));
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(AppError::InvalidInput(format!(
                    "Invalid EPUB container.xml: {error}"
                )));
            }
            _ => {}
        }
    }
    Err(AppError::InvalidInput(
        "EPUB container.xml has no package document".to_string(),
    ))
}

fn parse_opf(xml: &str) -> Result<OpfData, AppError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut opf = OpfData::default();
    let mut capture: Option<Vec<u8>> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let qualified_name = element.name();
                let name = local_name(qualified_name.as_ref());
                match name {
                    b"title" | b"creator" | b"language" => capture = Some(name.to_vec()),
                    b"item" => parse_manifest_item(&reader, &element, &mut opf)?,
                    b"itemref" => parse_spine_item(&reader, &element, &mut opf)?,
                    b"spine" => opf.toc_id = attribute_value(&reader, &element, b"toc")?,
                    _ => {}
                }
            }
            Ok(Event::Empty(element)) => match local_name(element.name().as_ref()) {
                b"item" => parse_manifest_item(&reader, &element, &mut opf)?,
                b"itemref" => parse_spine_item(&reader, &element, &mut opf)?,
                _ => {}
            },
            Ok(Event::Text(text)) if capture.is_some() => {
                let value = text
                    .xml_content()
                    .map_err(|error| AppError::InvalidInput(format!("Invalid OPF text: {error}")))?
                    .trim()
                    .to_string();
                match capture.as_deref() {
                    Some(b"title") if opf.title.is_empty() => opf.title = value,
                    Some(b"creator") if opf.author.is_none() => opf.author = Some(value),
                    Some(b"language") if opf.language.is_none() => opf.language = Some(value),
                    _ => {}
                }
            }
            Ok(Event::End(element)) => {
                if capture.as_deref() == Some(local_name(element.name().as_ref())) {
                    capture = None;
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(AppError::InvalidInput(format!(
                    "Invalid EPUB package document: {error}"
                )));
            }
            _ => {}
        }
    }
    Ok(opf)
}

fn parse_manifest_item(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
    opf: &mut OpfData,
) -> Result<(), AppError> {
    let Some(id) = attribute_value(reader, element, b"id")? else {
        return Ok(());
    };
    let Some(href) = attribute_value(reader, element, b"href")? else {
        return Ok(());
    };
    opf.manifest.insert(
        id,
        OpfItem {
            href,
            media_type: attribute_value(reader, element, b"media-type")?.unwrap_or_default(),
            properties: attribute_value(reader, element, b"properties")?.unwrap_or_default(),
        },
    );
    Ok(())
}

fn parse_spine_item(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
    opf: &mut OpfData,
) -> Result<(), AppError> {
    if let Some(idref) = attribute_value(reader, element, b"idref")? {
        opf.spine.push(idref);
    }
    Ok(())
}

fn load_navigation_labels(
    archive: &mut ZipArchive<File>,
    opf: &OpfData,
    opf_dir: &Path,
) -> Result<HashMap<String, NavLabel>, AppError> {
    if let Some(nav_item) = opf.manifest.values().find(|item| {
        item.properties
            .split_whitespace()
            .any(|value| value == "nav")
    }) {
        let nav_path = resolve_archive_path(opf_dir, &nav_item.href)?;
        if let Ok(xml) = read_zip_text(archive, &nav_path) {
            return parse_nav_document(&xml);
        }
    }

    let ncx_item = opf
        .toc_id
        .as_ref()
        .and_then(|id| opf.manifest.get(id))
        .or_else(|| {
            opf.manifest
                .values()
                .find(|item| item.media_type == "application/x-dtbncx+xml")
        });
    let Some(ncx_item) = ncx_item else {
        return Ok(HashMap::new());
    };
    let ncx_path = resolve_archive_path(opf_dir, &ncx_item.href)?;
    let xml = read_zip_text(archive, &ncx_path)?;
    parse_ncx(&xml)
}

fn parse_ncx(xml: &str) -> Result<HashMap<String, NavLabel>, AppError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut points: Vec<NavPoint> = Vec::new();
    let mut labels = HashMap::new();
    let mut in_label_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match local_name(element.name().as_ref()) {
                b"navPoint" => points.push(NavPoint::default()),
                b"text" if !points.is_empty() => in_label_text = true,
                b"content" if !points.is_empty() => {
                    if let Some(src) = attribute_value(&reader, &element, b"src")? {
                        points.last_mut().expect("checked").src = Some(src);
                    }
                }
                _ => {}
            },
            Ok(Event::Empty(element))
                if local_name(element.name().as_ref()) == b"content" && !points.is_empty() =>
            {
                if let Some(src) = attribute_value(&reader, &element, b"src")? {
                    points.last_mut().expect("checked").src = Some(src);
                }
            }
            Ok(Event::Text(text)) if in_label_text && !points.is_empty() => {
                points
                    .last_mut()
                    .expect("checked")
                    .label
                    .push_str(&text.xml_content().map_err(|error| {
                        AppError::InvalidInput(format!("Invalid EPUB navigation text: {error}"))
                    })?);
            }
            Ok(Event::End(element)) => match local_name(element.name().as_ref()) {
                b"text" => in_label_text = false,
                b"navPoint" => {
                    if let Some(point) = points.pop() {
                        insert_nav_point(&mut labels, &points, point);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(AppError::InvalidInput(format!(
                    "Invalid EPUB NCX navigation: {error}"
                )));
            }
            _ => {}
        }
    }
    Ok(labels)
}

fn parse_nav_document(xml: &str) -> Result<HashMap<String, NavLabel>, AppError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut labels = HashMap::new();
    let mut list_depth = 0_usize;
    let mut anchors: Vec<NavPoint> = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => match local_name(element.name().as_ref()) {
                b"ol" => list_depth += 1,
                b"a" if list_depth > 0 => {
                    anchors.push(NavPoint {
                        label: String::new(),
                        src: attribute_value(&reader, &element, b"href")?,
                    });
                }
                _ => {}
            },
            Ok(Event::Text(text)) if !anchors.is_empty() => {
                anchors
                    .last_mut()
                    .expect("checked")
                    .label
                    .push_str(&text.xml_content().map_err(|error| {
                        AppError::InvalidInput(format!("Invalid EPUB nav text: {error}"))
                    })?);
            }
            Ok(Event::End(element)) => match local_name(element.name().as_ref()) {
                b"a" => {
                    if let Some(anchor) = anchors.pop() {
                        if let Some(src) = anchor.src {
                            labels.entry(normalize_href(&src)).or_insert(NavLabel {
                                title: anchor.label.trim().to_string(),
                                volume: None,
                            });
                        }
                    }
                }
                b"ol" => list_depth = list_depth.saturating_sub(1),
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(AppError::InvalidInput(format!(
                    "Invalid EPUB navigation document: {error}"
                )));
            }
            _ => {}
        }
    }
    Ok(labels)
}

fn insert_nav_point(labels: &mut HashMap<String, NavLabel>, parents: &[NavPoint], point: NavPoint) {
    let Some(src) = point.src else {
        return;
    };
    let title = point.label.trim();
    if title.is_empty() {
        return;
    }
    let volume = parents.iter().rev().find_map(|parent| {
        (!parent.label.trim().is_empty()).then(|| parent.label.trim().to_string())
    });
    labels.entry(normalize_href(&src)).or_insert(NavLabel {
        title: title.to_string(),
        volume,
    });
}

fn is_document_item(item: &OpfItem) -> bool {
    matches!(
        item.media_type.as_str(),
        "application/xhtml+xml" | "text/html" | "application/xml"
    ) || item.href.ends_with(".xhtml")
        || item.href.ends_with(".html")
        || item.href.ends_with(".htm")
}

fn extract_xhtml_text(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut output = String::new();
    let mut skip_depth = 0_usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let qualified_name = element.name();
                let name = local_name(qualified_name.as_ref());
                if skip_depth > 0 {
                    skip_depth += 1;
                } else if is_skipped_tag(name) {
                    skip_depth = 1;
                } else if is_block_tag(name) {
                    push_line_break(&mut output);
                }
            }
            Ok(Event::Empty(element)) if skip_depth == 0 => {
                if is_block_tag(local_name(element.name().as_ref())) {
                    push_line_break(&mut output);
                }
            }
            Ok(Event::Text(text)) if skip_depth == 0 => {
                if let Ok(value) = text.xml_content() {
                    push_collapsed_text(&mut output, &value);
                }
            }
            Ok(Event::CData(text)) if skip_depth == 0 => {
                if let Ok(value) = text.xml_content() {
                    push_collapsed_text(&mut output, &value);
                }
            }
            Ok(Event::End(element)) => {
                if skip_depth > 0 {
                    skip_depth -= 1;
                } else if is_block_tag(local_name(element.name().as_ref())) {
                    push_line_break(&mut output);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    normalize_extracted_text(&output)
}

fn is_skipped_tag(name: &[u8]) -> bool {
    matches!(name, b"head" | b"style" | b"script" | b"svg" | b"nav")
}

fn is_block_tag(name: &[u8]) -> bool {
    matches!(
        name,
        b"p" | b"div"
            | b"br"
            | b"li"
            | b"section"
            | b"article"
            | b"blockquote"
            | b"h1"
            | b"h2"
            | b"h3"
            | b"h4"
            | b"h5"
            | b"h6"
    )
}

fn push_line_break(output: &mut String) {
    while output.ends_with(' ') || output.ends_with('\t') {
        output.pop();
    }
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
}

fn push_collapsed_text(output: &mut String, text: &str) {
    for segment in text.split_whitespace() {
        if segment.is_empty() {
            continue;
        }
        if output
            .chars()
            .last()
            .is_some_and(|character| !character.is_whitespace())
            && segment
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_alphanumeric())
            && output
                .chars()
                .last()
                .is_some_and(|character| character.is_ascii_alphanumeric())
        {
            output.push(' ');
        }
        output.push_str(segment);
    }
}

fn normalize_extracted_text(text: &str) -> String {
    let mut lines = Vec::new();
    let mut previous_blank = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !previous_blank && !lines.is_empty() {
                lines.push(String::new());
            }
            previous_blank = true;
        } else {
            lines.push(trimmed.to_string());
            previous_blank = false;
        }
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines.join("\n")
}

fn first_nonempty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn strip_repeated_heading(text: &str, title: &str) -> String {
    let lines = text.lines().collect::<Vec<_>>();
    let normalized_title = normalize_heading(title);
    for count in 1..=3.min(lines.len()) {
        let candidate = lines[..count].join(" ");
        if normalize_heading(&candidate) == normalized_title {
            return lines[count..].join("\n").trim().to_string();
        }
    }
    text.trim().to_string()
}

fn normalize_heading(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace() && !character.is_ascii_punctuation())
        .collect::<String>()
        .to_lowercase()
}

fn resolve_archive_path(base: &Path, href: &str) -> Result<String, AppError> {
    let decoded = percent_decode(href.split('#').next().unwrap_or_default());
    let path = base.join(decoded);
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(AppError::InvalidInput(format!("Unsafe EPUB path: {href}")));
                }
            }
            _ => {
                return Err(AppError::InvalidInput(format!("Unsafe EPUB path: {href}")));
            }
        }
    }
    Ok(normalized.to_string_lossy().replace('\\', "/"))
}

fn normalize_href(href: &str) -> String {
    percent_decode(href.split('#').next().unwrap_or_default())
        .trim_start_matches("./")
        .replace('\\', "/")
}

fn percent_decode(value: &str) -> String {
    urlencoding::decode(value)
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| value.to_string())
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn attribute_value(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
    name: &[u8],
) -> Result<Option<String>, AppError> {
    for attribute in element.attributes().with_checks(false) {
        let attribute = attribute
            .map_err(|error| AppError::InvalidInput(format!("Invalid XML attribute: {error}")))?;
        if local_name(attribute.key.as_ref()) == name {
            return attribute
                .decode_and_unescape_value(reader.decoder())
                .map(|value| Some(value.into_owned()))
                .map_err(|error| {
                    AppError::InvalidInput(format!("Invalid XML attribute value: {error}"))
                });
        }
    }
    Ok(None)
}

fn create_literary_study_project_inner(
    request: CreateLiteraryStudyProjectRequest,
) -> Result<CreateLiteraryStudyProjectResult, AppError> {
    validate_project_request(&request)?;
    let parent = PathBuf::from(&request.parent_dir);
    if !parent.is_dir() {
        return Err(AppError::NotADirectory(request.parent_dir));
    }
    let destination = parent.join(&request.project_name);
    if destination.exists() {
        return Err(AppError::InvalidInput(format!(
            "Directory already exists: {}",
            destination.display()
        )));
    }

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(
        ".{}.novelist-import-{}-{unique}",
        sanitize_path_component(&request.project_name),
        std::process::id()
    ));
    std::fs::create_dir(&temporary)?;

    let result = build_literary_project(&temporary, &request).and_then(|paths| {
        std::fs::rename(&temporary, &destination)?;
        Ok(paths)
    });
    if result.is_err() && temporary.exists() {
        let _ = std::fs::remove_dir_all(&temporary);
    }

    let relative_paths = result?;
    let first_index = request
        .chapters
        .iter()
        .position(|chapter| looks_like_chapter_heading(chapter.title.trim()))
        .unwrap_or(0);
    let first_relative = relative_paths.get(first_index).ok_or_else(|| {
        AppError::InvalidInput("Literary project requires at least one chapter".to_string())
    })?;
    Ok(CreateLiteraryStudyProjectResult {
        project_path: destination.to_string_lossy().to_string(),
        first_chapter_path: destination
            .join(first_relative)
            .to_string_lossy()
            .to_string(),
        chapter_count: relative_paths.len(),
    })
}

#[derive(Debug)]
struct LiteraryProjectSnapshot {
    root: PathBuf,
    config: ProjectConfig,
    metadata: LiteraryProjectMetadata,
    chapters: Vec<(String, LiteraryStudyFile)>,
}

fn read_literary_study_overview_inner(
    project_dir: &str,
) -> Result<LiteraryStudyOverview, AppError> {
    let snapshot = load_literary_project(project_dir)?;
    Ok(build_literary_overview(&snapshot))
}

fn replace_literary_study_book_inner(
    request: ReplaceLiteraryStudyBookRequest,
) -> Result<ReplaceLiteraryStudyBookResult, AppError> {
    validate_book_request(
        &request.title,
        &request.chapters,
        "Select at least one replacement chapter",
    )?;
    let snapshot = load_literary_project(&request.project_dir)?;
    let (study_files, preserved_chapter_count) = build_study_files(
        &request.title,
        request.author.as_deref(),
        request.language.as_deref(),
        &request.chapters,
        Some(&snapshot.chapters),
    );
    let relative_paths = study_files
        .iter()
        .map(|(relative, _)| relative.clone())
        .collect::<Vec<_>>();
    let first_relative = relative_paths.first().ok_or_else(|| {
        AppError::InvalidInput("Literary project requires at least one chapter".to_string())
    })?;
    let resume_relative = study_files
        .iter()
        .find(|(_, study)| !study_is_complete(study))
        .map(|(relative, _)| relative)
        .unwrap_or(first_relative);

    let novelist_dir = snapshot.root.join(".novelist");
    let unique = unique_suffix();
    let stage_dir = novelist_dir.join(format!(".literary-stage-{unique}"));
    let backup_dir = novelist_dir.join(format!(".literary-backup-{unique}"));
    std::fs::create_dir(&stage_dir)?;
    std::fs::create_dir(&backup_dir)?;

    let config_path = novelist_dir.join("project.toml");
    let metadata_path = novelist_dir.join(LITERARY_METADATA_FILE);
    let original_config = std::fs::read(&config_path)?;
    let original_metadata = std::fs::read(&metadata_path)?;
    let mut moved_old = Vec::<String>::new();
    let mut moved_new = Vec::<String>::new();

    let transaction = (|| -> Result<(), AppError> {
        write_study_files(&stage_dir, &study_files)?;

        for (relative, _) in &snapshot.chapters {
            let source = checked_project_path(&snapshot.root, relative)?;
            if !source.exists() {
                continue;
            }
            let destination = checked_project_path(&backup_dir, relative)?;
            ensure_safe_parent(&backup_dir, relative)?;
            std::fs::rename(&source, &destination)?;
            moved_old.push(relative.clone());
        }

        for (relative, _) in &study_files {
            let source = checked_project_path(&stage_dir, relative)?;
            let destination = checked_project_path(&snapshot.root, relative)?;
            ensure_safe_parent(&snapshot.root, relative)?;
            if destination.exists() {
                return Err(AppError::InvalidInput(format!(
                    "Replacement chapter collides with an unmanaged file: {}",
                    destination.display()
                )));
            }
            std::fs::rename(&source, &destination)?;
            moved_new.push(relative.clone());
        }

        let mut next_config = snapshot.config.clone();
        next_config.outline.order = relative_paths.clone();
        next_config
            .plugins
            .enabled
            .insert(LITERARY_PLUGIN_ID.to_string(), true);
        let next_metadata = LiteraryProjectMetadata {
            schema_version: LITERARY_SCHEMA_VERSION,
            source_path: request.source_path.clone(),
            title: request.title.trim().to_string(),
            author: normalize_optional_text(request.author.clone()),
            language: normalize_optional_text(request.language.clone()),
            chapter_count: study_files.len(),
            content_root: Some(LITERARY_CONTENT_ROOT.to_string()),
            chapter_paths: relative_paths.clone(),
        };

        atomic_write_sync(&config_path, toml::to_string(&next_config)?.as_bytes())?;
        atomic_write_sync(
            &metadata_path,
            serde_json::to_string_pretty(&next_metadata)?.as_bytes(),
        )?;
        Ok(())
    })();

    if let Err(error) = transaction {
        let mut rollback_errors = Vec::new();
        if let Err(rollback_error) = atomic_write_sync(&config_path, &original_config) {
            rollback_errors.push(format!("project config: {rollback_error}"));
        }
        if let Err(rollback_error) = atomic_write_sync(&metadata_path, &original_metadata) {
            rollback_errors.push(format!("metadata: {rollback_error}"));
        }
        for relative in moved_new.iter().rev() {
            match checked_project_path(&snapshot.root, relative) {
                Ok(path) if path.exists() => {
                    if let Err(rollback_error) = std::fs::remove_file(&path) {
                        rollback_errors
                            .push(format!("remove {}: {rollback_error}", path.display()));
                    }
                }
                Ok(_) => {}
                Err(rollback_error) => rollback_errors.push(rollback_error.to_string()),
            }
        }
        for relative in moved_old.iter().rev() {
            let source = checked_project_path(&backup_dir, relative);
            let destination = checked_project_path(&snapshot.root, relative);
            match (source, destination) {
                (Ok(source), Ok(destination)) if source.exists() => {
                    if let Err(rollback_error) = ensure_safe_parent(&snapshot.root, relative)
                        .and_then(|_| std::fs::rename(&source, &destination).map_err(AppError::Io))
                    {
                        rollback_errors.push(format!(
                            "restore {}: {rollback_error}",
                            destination.display()
                        ));
                    }
                }
                (Err(rollback_error), _) | (_, Err(rollback_error)) => {
                    rollback_errors.push(rollback_error.to_string())
                }
                _ => {}
            }
        }
        let _ = std::fs::remove_dir_all(&stage_dir);
        let _ = std::fs::remove_dir_all(&backup_dir);
        if rollback_errors.is_empty() {
            return Err(error);
        }
        return Err(AppError::Custom(format!(
            "{error}; rollback also reported: {}",
            rollback_errors.join("; ")
        )));
    }

    let _ = std::fs::remove_dir_all(&stage_dir);
    let _ = std::fs::remove_dir_all(&backup_dir);
    prune_empty_chapter_directories(&snapshot.root, &snapshot.chapters);

    Ok(ReplaceLiteraryStudyBookResult {
        first_chapter_path: snapshot
            .root
            .join(first_relative)
            .to_string_lossy()
            .to_string(),
        resume_chapter_path: snapshot
            .root
            .join(resume_relative)
            .to_string_lossy()
            .to_string(),
        chapter_count: study_files.len(),
        preserved_chapter_count,
    })
}

fn validate_project_request(request: &CreateLiteraryStudyProjectRequest) -> Result<(), AppError> {
    if request.project_name.trim().is_empty()
        || request.project_name.contains('/')
        || request.project_name.contains('\\')
        || request.project_name.contains('\0')
        || request.project_name == "."
        || request.project_name == ".."
    {
        return Err(AppError::InvalidInput(
            "Project name cannot be empty or contain path separators".to_string(),
        ));
    }
    validate_book_request(
        &request.title,
        &request.chapters,
        "Select at least one chapter",
    )
}

fn validate_book_request(
    title: &str,
    chapters: &[LiteraryChapterDraft],
    empty_message: &str,
) -> Result<(), AppError> {
    if title.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Book title cannot be empty".to_string(),
        ));
    }
    if chapters.is_empty() {
        return Err(AppError::InvalidInput(empty_message.to_string()));
    }
    if chapters.len() > MAX_LITERARY_CHAPTERS {
        return Err(AppError::InvalidInput(format!(
            "Literary projects support at most {MAX_LITERARY_CHAPTERS} chapters"
        )));
    }
    if chapters
        .iter()
        .any(|chapter| chapter.title.trim().is_empty() || chapter.text.trim().is_empty())
    {
        return Err(AppError::InvalidInput(
            "Every chapter needs a title and source text".to_string(),
        ));
    }
    Ok(())
}

fn build_literary_project(
    root: &Path,
    request: &CreateLiteraryStudyProjectRequest,
) -> Result<Vec<String>, AppError> {
    let novelist_dir = root.join(".novelist");
    std::fs::create_dir_all(&novelist_dir)?;

    let (study_files, _) = build_study_files(
        &request.title,
        request.author.as_deref(),
        request.language.as_deref(),
        &request.chapters,
        None,
    );
    let relative_paths = study_files
        .iter()
        .map(|(relative, _)| relative.clone())
        .collect::<Vec<_>>();
    let mut plugins = PluginsConfig::default();
    plugins.enabled.insert(LITERARY_PLUGIN_ID.to_string(), true);
    let project_config = ProjectConfig {
        project: ProjectMeta {
            name: request.project_name.trim().to_string(),
            project_type: "literary-study".to_string(),
            version: "0.1.0".to_string(),
        },
        outline: OutlineConfig {
            order: relative_paths.clone(),
        },
        writing: WritingConfig::default(),
        view: Default::default(),
        new_file: Default::default(),
        plugins,
        active_image_host_id: None,
    };
    atomic_write_sync(
        &novelist_dir.join("project.toml"),
        toml::to_string(&project_config)?.as_bytes(),
    )?;
    atomic_write_sync(
        &novelist_dir.join(LITERARY_METADATA_FILE),
        serde_json::to_string_pretty(&LiteraryProjectMetadata {
            schema_version: LITERARY_SCHEMA_VERSION,
            source_path: request.source_path.clone(),
            title: request.title.trim().to_string(),
            author: normalize_optional_text(request.author.clone()),
            language: normalize_optional_text(request.language.clone()),
            chapter_count: request.chapters.len(),
            content_root: Some(LITERARY_CONTENT_ROOT.to_string()),
            chapter_paths: relative_paths.clone(),
        })?
        .as_bytes(),
    )?;
    write_study_files(root, &study_files)?;
    Ok(relative_paths)
}

fn build_study_files(
    title: &str,
    author: Option<&str>,
    language: Option<&str>,
    chapters: &[LiteraryChapterDraft],
    existing: Option<&[(String, LiteraryStudyFile)]>,
) -> (Vec<(String, LiteraryStudyFile)>, usize) {
    let relative_paths = chapter_relative_paths(chapters);
    let mut existing_by_label = HashMap::<(String, String), Vec<LiteraryStudyFile>>::new();
    if let Some(existing) = existing {
        for (_, study) in existing.iter().rev() {
            existing_by_label
                .entry(chapter_match_key(
                    study.chapter.volume.as_deref(),
                    &study.chapter.title,
                ))
                .or_default()
                .push(study.clone());
        }
    }

    let mut preserved = 0;
    let studies = chapters
        .iter()
        .enumerate()
        .map(|(index, chapter)| {
            let mut study = LiteraryStudyFile {
                schema_version: 1,
                book: LiteraryBook {
                    title: title.trim().to_string(),
                    author: author
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                    language: language
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                },
                chapter: LiteraryChapter {
                    id: if chapter.id.trim().is_empty() {
                        format!("chapter-{:04}", index + 1)
                    } else {
                        chapter.id.clone()
                    },
                    title: chapter.title.trim().to_string(),
                    volume: chapter
                        .volume
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                    index: index + 1,
                    total: chapters.len(),
                    previous_path: index
                        .checked_sub(1)
                        .and_then(|previous| relative_paths.get(previous))
                        .cloned(),
                    next_path: relative_paths.get(index + 1).cloned(),
                },
                source: chapter.text.trim().to_string(),
                source_cursor: 0,
                insertions: Vec::new(),
                stats: LiteraryStats {
                    correct: 0,
                    mistakes: 0,
                    pasted: 0,
                    started_at: None,
                    completed_at: None,
                },
            };

            let key = chapter_match_key(chapter.volume.as_deref(), chapter.title.trim());
            if let Some(candidates) = existing_by_label.get_mut(&key) {
                if let Some(previous) = candidates.pop() {
                    if preserve_compatible_progress(&mut study, &previous) {
                        preserved += 1;
                    }
                }
            }
            (relative_paths[index].clone(), study)
        })
        .collect();
    (studies, preserved)
}

fn chapter_match_key(volume: Option<&str>, title: &str) -> (String, String) {
    (
        volume
            .unwrap_or_default()
            .split_whitespace()
            .collect::<String>(),
        title.split_whitespace().collect::<String>(),
    )
}

fn preserve_compatible_progress(
    replacement: &mut LiteraryStudyFile,
    previous: &LiteraryStudyFile,
) -> bool {
    let previous_cursor = clamp_utf16_offset(&previous.source, previous.source_cursor);
    let replacement_units = utf16_len(&replacement.source);
    let compatible = previous.source == replacement.source
        || (previous_cursor <= replacement_units
            && utf16_prefix_matches(&previous.source, &replacement.source, previous_cursor));
    if !compatible {
        return false;
    }

    replacement.source_cursor = previous_cursor;
    replacement.insertions = previous
        .insertions
        .iter()
        .filter(|insertion| insertion.source_offset <= previous_cursor)
        .cloned()
        .collect();
    replacement.stats = previous.stats.clone();
    replacement.stats.correct = copied_character_count(&replacement.source, previous_cursor);
    replacement.stats.mistakes = replacement
        .insertions
        .iter()
        .filter(|insertion| insertion.kind == "mistake")
        .map(|insertion| insertion.text.chars().count())
        .sum();
    replacement.stats.completed_at = if previous_cursor >= replacement_units {
        previous.stats.completed_at.clone()
    } else {
        None
    };
    previous_cursor > 0
        || !replacement.insertions.is_empty()
        || replacement.stats.started_at.is_some()
}

fn chapter_relative_paths(chapters: &[LiteraryChapterDraft]) -> Vec<String> {
    let mut volume_numbers: HashMap<String, usize> = HashMap::new();
    let mut next_volume = 1_usize;

    chapters
        .iter()
        .enumerate()
        .map(|(index, chapter)| {
            let filename = format!(
                "{:04} {}.litstudy",
                index + 1,
                sanitize_path_component(chapter.title.trim())
            );
            let inner = if let Some(volume) = chapter
                .volume
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let number = *volume_numbers.entry(volume.to_string()).or_insert_with(|| {
                    let number = next_volume;
                    next_volume += 1;
                    number
                });
                format!(
                    "{:02} {}/{}",
                    number,
                    sanitize_path_component(volume),
                    filename
                )
            } else {
                format!("章节/{filename}")
            };
            format!("{LITERARY_CONTENT_ROOT}/{inner}")
        })
        .collect()
}

fn load_literary_project(project_dir: &str) -> Result<LiteraryProjectSnapshot, AppError> {
    let requested = PathBuf::from(project_dir);
    if !requested.is_dir() {
        return Err(AppError::NotADirectory(project_dir.to_string()));
    }
    let root = std::fs::canonicalize(&requested)?;
    let novelist_dir = root.join(".novelist");
    let novelist_metadata = std::fs::symlink_metadata(&novelist_dir)?;
    if novelist_metadata.file_type().is_symlink() || !novelist_metadata.is_dir() {
        return Err(AppError::PathNotAllowed(format!(
            "Invalid literary metadata directory: {}",
            novelist_dir.display()
        )));
    }
    let config: ProjectConfig =
        read_json_or_toml_bounded(&novelist_dir.join("project.toml"), false)?;
    if config.project.project_type != "literary-study" {
        return Err(AppError::InvalidInput(
            "The selected directory is not a literary study project".to_string(),
        ));
    }
    let metadata: LiteraryProjectMetadata =
        read_json_or_toml_bounded(&novelist_dir.join(LITERARY_METADATA_FILE), true)?;
    let chapter_paths = discover_literary_chapter_paths(&root, &config, &metadata)?;
    let mut chapters = Vec::with_capacity(chapter_paths.len());
    for relative in chapter_paths {
        let path = checked_project_path(&root, &relative)?;
        let study: LiteraryStudyFile = read_json_bounded(&path, MAX_LITERARY_CHAPTER_BYTES)?;
        chapters.push((relative, study));
    }
    chapters.sort_by(|(left_path, left), (right_path, right)| {
        left.chapter
            .index
            .cmp(&right.chapter.index)
            .then(left_path.cmp(right_path))
    });
    Ok(LiteraryProjectSnapshot {
        root,
        config,
        metadata,
        chapters,
    })
}

fn discover_literary_chapter_paths(
    root: &Path,
    config: &ProjectConfig,
    metadata: &LiteraryProjectMetadata,
) -> Result<Vec<String>, AppError> {
    let declared = if !metadata.chapter_paths.is_empty() {
        metadata.chapter_paths.clone()
    } else {
        config
            .outline
            .order
            .iter()
            .filter(|path| path.to_ascii_lowercase().ends_with(".litstudy"))
            .cloned()
            .collect()
    };
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for path in declared {
        let normalized = normalize_project_relative_path(&path)?;
        if seen.insert(normalized.clone()) {
            paths.push(normalized);
        }
    }
    if !paths.is_empty() {
        return Ok(paths);
    }

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".novelist")
    {
        let entry = entry.map_err(|error| AppError::Custom(error.to_string()))?;
        if entry.file_type().is_symlink() {
            continue;
        }
        if entry.file_type().is_dir() && entry.file_name() == ".novelist" {
            continue;
        }
        if !entry.file_type().is_file()
            || entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .is_none_or(|value| !value.eq_ignore_ascii_case("litstudy"))
        {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|error| AppError::Custom(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        if seen.insert(relative.clone()) {
            paths.push(relative);
        }
    }
    if paths.is_empty() {
        return Err(AppError::InvalidInput(
            "This literary study project contains no readable chapters".to_string(),
        ));
    }
    Ok(paths)
}

fn build_literary_overview(snapshot: &LiteraryProjectSnapshot) -> LiteraryStudyOverview {
    let mut completed_chapters = 0;
    let mut copied_characters = 0;
    let mut total_characters = 0;
    let mut mistakes = 0;
    let mut pasted = 0;
    let mut resume_chapter_path = None;
    let total = snapshot.chapters.len();
    let chapters: Vec<LiteraryChapterSummary> = snapshot
        .chapters
        .iter()
        .enumerate()
        .map(|(position, (relative_path, study))| {
            let source_characters = study.source.chars().count();
            let copied = copied_character_count(&study.source, study.source_cursor);
            let completed = study_is_complete(study);
            if completed {
                completed_chapters += 1;
            } else if resume_chapter_path.is_none() {
                resume_chapter_path = Some(relative_path.clone());
            }
            copied_characters += copied;
            total_characters += source_characters;
            mistakes += study.stats.mistakes;
            pasted += study.stats.pasted;
            LiteraryChapterSummary {
                id: study.chapter.id.clone(),
                title: study.chapter.title.clone(),
                volume: study.chapter.volume.clone(),
                index: position + 1,
                total,
                relative_path: relative_path.clone(),
                source_characters,
                copied_characters: copied,
                mistakes: study.stats.mistakes,
                pasted: study.stats.pasted,
                completed,
            }
        })
        .collect();
    LiteraryStudyOverview {
        schema_version: snapshot.metadata.schema_version,
        source_path: snapshot.metadata.source_path.clone(),
        title: snapshot.metadata.title.clone(),
        author: snapshot.metadata.author.clone(),
        language: snapshot.metadata.language.clone(),
        chapter_count: chapters.len(),
        completed_chapters,
        copied_characters,
        total_characters,
        mistakes,
        pasted,
        resume_chapter_path,
        chapters,
    }
}

fn study_is_complete(study: &LiteraryStudyFile) -> bool {
    clamp_utf16_offset(&study.source, study.source_cursor) >= utf16_len(&study.source)
}

fn copied_character_count(source: &str, cursor: usize) -> usize {
    let cursor = clamp_utf16_offset(source, cursor);
    let mut units = 0;
    let mut characters = 0;
    for character in source.chars() {
        let next = units + character.len_utf16();
        if next > cursor {
            break;
        }
        units = next;
        characters += 1;
    }
    characters
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn clamp_utf16_offset(value: &str, requested: usize) -> usize {
    let mut offset = 0;
    for character in value.chars() {
        let next = offset + character.len_utf16();
        if next > requested {
            break;
        }
        offset = next;
    }
    offset
}

fn utf16_prefix_matches(left: &str, right: &str, units: usize) -> bool {
    let Some(left_index) = byte_index_for_utf16_offset(left, units) else {
        return false;
    };
    let Some(right_index) = byte_index_for_utf16_offset(right, units) else {
        return false;
    };
    left[..left_index] == right[..right_index]
}

fn byte_index_for_utf16_offset(value: &str, target: usize) -> Option<usize> {
    if target == 0 {
        return Some(0);
    }
    let mut units = 0;
    for (index, character) in value.char_indices() {
        units += character.len_utf16();
        if units == target {
            return Some(index + character.len_utf8());
        }
        if units > target {
            return None;
        }
    }
    (units == target).then_some(value.len())
}

fn write_study_files(
    root: &Path,
    study_files: &[(String, LiteraryStudyFile)],
) -> Result<(), AppError> {
    for (relative, study) in study_files {
        ensure_safe_parent(root, relative)?;
        let path = checked_project_path(root, relative)?;
        let bytes = serde_json::to_vec_pretty(study)?;
        if bytes.len() as u64 > MAX_LITERARY_CHAPTER_BYTES {
            return Err(AppError::InvalidInput(format!(
                "Literary chapter is too large to store safely: {}",
                study.chapter.title
            )));
        }
        atomic_write_sync(&path, &bytes)?;
    }
    Ok(())
}

fn read_json_or_toml_bounded<T>(path: &Path, json: bool) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    let bytes = read_bounded(path, MAX_LITERARY_METADATA_BYTES)?;
    let text = String::from_utf8(bytes)
        .map_err(|error| AppError::InvalidInput(format!("Invalid UTF-8 metadata: {error}")))?;
    if json {
        serde_json::from_str(&text).map_err(AppError::from)
    } else {
        toml::from_str(&text).map_err(AppError::from)
    }
}

fn read_json_bounded<T>(path: &Path, max_bytes: u64) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    let bytes = read_bounded(path, max_bytes)?;
    serde_json::from_slice(&bytes).map_err(AppError::from)
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, AppError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::PathNotAllowed(format!(
            "Literary data must be a regular file: {}",
            path.display()
        )));
    }
    if metadata.len() > max_bytes {
        return Err(AppError::InvalidInput(format!(
            "Literary data is too large: {}",
            path.display()
        )));
    }
    Ok(std::fs::read(path)?)
}

fn normalize_project_relative_path(value: &str) -> Result<String, AppError> {
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(AppError::PathNotAllowed(value.to_string()));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            Component::CurDir => {}
            _ => return Err(AppError::PathNotAllowed(value.to_string())),
        }
    }
    if normalized.as_os_str().is_empty()
        || normalized
            .components()
            .next()
            .is_some_and(|component| component.as_os_str() == ".novelist")
        || normalized
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("litstudy"))
    {
        return Err(AppError::PathNotAllowed(value.to_string()));
    }
    Ok(normalized.to_string_lossy().replace('\\', "/"))
}

fn checked_project_path(root: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let normalized = normalize_project_relative_path(relative)?;
    Ok(root.join(normalized))
}

fn ensure_safe_parent(root: &Path, relative_file: &str) -> Result<(), AppError> {
    let normalized = normalize_project_relative_path(relative_file)?;
    let relative_parent = Path::new(&normalized)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let mut current = root.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(name) = component else {
            return Err(AppError::PathNotAllowed(relative_file.to_string()));
        };
        current.push(name);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(AppError::PathNotAllowed(format!(
                        "Literary chapter parent is not a regular directory: {}",
                        current.display()
                    )));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)?;
            }
            Err(error) => return Err(AppError::Io(error)),
        }
    }
    Ok(())
}

fn atomic_write_sync(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Literary data path has no parent".to_string()))?;
    std::fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Literary data path has no file name".to_string()))?
        .to_string_lossy();
    let mut last_collision = None;
    for attempt in 0..32_u64 {
        let temporary = parent.join(format!(
            ".{file_name}.novelist-tmp-{}-{}-{}",
            std::process::id(),
            unique_suffix(),
            attempt
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(mut file) => {
                let write_result = (|| -> Result<(), AppError> {
                    file.write_all(bytes)?;
                    file.flush()?;
                    file.sync_all()?;
                    Ok(())
                })();
                drop(file);
                if let Err(error) = write_result {
                    let _ = std::fs::remove_file(&temporary);
                    return Err(error);
                }
                if let Err(error) = std::fs::rename(&temporary, path) {
                    let _ = std::fs::remove_file(&temporary);
                    return Err(AppError::Io(error));
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_collision = Some(error);
            }
            Err(error) => return Err(AppError::Io(error)),
        }
    }
    Err(AppError::Io(last_collision.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "Unable to allocate a literary data temporary file",
        )
    })))
}

fn prune_empty_chapter_directories(root: &Path, previous: &[(String, LiteraryStudyFile)]) {
    let mut directories = previous
        .iter()
        .filter_map(|(relative, _)| Path::new(relative).parent())
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    directories.dedup();
    for relative in directories {
        let path = root.join(&relative);
        if path == root || relative.starts_with(".novelist") {
            continue;
        }
        let _ = std::fs::remove_dir(&path);
    }
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn sanitize_path_component(value: &str) -> String {
    let mut sanitized = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    sanitized = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    sanitized = sanitized.trim_matches(['.', ' ']).to_string();
    if sanitized.is_empty() {
        "未命名".to_string()
    } else {
        sanitized.chars().take(96).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn splits_common_chinese_txt_headings() {
        let chapters =
            split_txt_chapters("前言内容\n\n第一章 小二上酒\n正文一\n第二章 山雨欲来\n正文二");
        assert_eq!(chapters.len(), 3);
        assert_eq!(chapters[0].title, "正文");
        assert_eq!(chapters[1].title, "第一章 小二上酒");
        assert_eq!(chapters[2].text, "正文二");
    }

    #[test]
    fn extracts_xhtml_without_style_or_script_text() {
        let text = extract_xhtml_text(
            r#"<html><head><style>hidden</style></head><body><h3>第一章</h3><p>最终，<b>师叔祖</b>胜了。</p><script>bad()</script><p>下一段</p></body></html>"#,
        );
        assert_eq!(text, "第一章\n最终，师叔祖胜了。\n下一段");
    }

    #[test]
    fn strips_heading_split_across_multiple_lines() {
        assert_eq!(
            strip_repeated_heading("第一章\n小二上酒\n北凉王府", "第一章 小二上酒"),
            "北凉王府"
        );
    }

    #[test]
    fn creates_project_with_linked_chapter_files() {
        let parent = tempfile::tempdir().unwrap();
        let request = CreateLiteraryStudyProjectRequest {
            project_name: "雪中学习".to_string(),
            parent_dir: parent.path().to_string_lossy().to_string(),
            source_path: "/tmp/book.epub".to_string(),
            title: "雪中悍刀行".to_string(),
            author: Some("烽火戏诸侯".to_string()),
            language: Some("zh-CN".to_string()),
            chapters: vec![
                LiteraryChapterDraft {
                    id: "c1".to_string(),
                    volume: Some("白马出凉州".to_string()),
                    title: "第一章".to_string(),
                    text: "正文一".to_string(),
                },
                LiteraryChapterDraft {
                    id: "c2".to_string(),
                    volume: Some("白马出凉州".to_string()),
                    title: "第二章".to_string(),
                    text: "正文二".to_string(),
                },
            ],
        };
        let result = create_literary_study_project_inner(request).unwrap();
        assert_eq!(result.chapter_count, 2);
        let first = std::fs::read_to_string(result.first_chapter_path).unwrap();
        assert!(first.contains("\"nextPath\": \"学习内容/01 白马出凉州/0002 第二章.litstudy\""));
        let overview = read_literary_study_overview_inner(&result.project_path).unwrap();
        assert_eq!(overview.chapter_count, 2);
        assert_eq!(overview.completed_chapters, 0);
        assert_eq!(
            overview.resume_chapter_path.as_deref(),
            Some("学习内容/01 白马出凉州/0001 第一章.litstudy")
        );
    }

    #[test]
    fn replacing_book_preserves_compatible_chapter_progress() {
        let parent = tempfile::tempdir().unwrap();
        let created = create_literary_study_project_inner(CreateLiteraryStudyProjectRequest {
            project_name: "学习项目".to_string(),
            parent_dir: parent.path().to_string_lossy().to_string(),
            source_path: "/tmp/original.epub".to_string(),
            title: "原书".to_string(),
            author: Some("作者".to_string()),
            language: Some("zh-CN".to_string()),
            chapters: vec![LiteraryChapterDraft {
                id: "c1".to_string(),
                volume: None,
                title: "第一章".to_string(),
                text: "甲乙丙丁".to_string(),
            }],
        })
        .unwrap();
        let mut study: LiteraryStudyFile =
            serde_json::from_str(&std::fs::read_to_string(&created.first_chapter_path).unwrap())
                .unwrap();
        study.source_cursor = 2;
        study.stats.correct = 2;
        study.stats.started_at = Some("2026-08-04T00:00:00Z".to_string());
        study.insertions.push(LiteraryInsertion {
            id: "comment-1".to_string(),
            source_offset: 2,
            order: 0,
            kind: "comment".to_string(),
            text: "批注".to_string(),
        });
        atomic_write_sync(
            Path::new(&created.first_chapter_path),
            serde_json::to_string_pretty(&study).unwrap().as_bytes(),
        )
        .unwrap();

        let replaced = replace_literary_study_book_inner(ReplaceLiteraryStudyBookRequest {
            project_dir: created.project_path.clone(),
            source_path: "/tmp/revised.epub".to_string(),
            title: "修订版".to_string(),
            author: Some("作者".to_string()),
            language: Some("zh-CN".to_string()),
            chapters: vec![
                LiteraryChapterDraft {
                    id: "new-c1".to_string(),
                    volume: None,
                    title: "第一章".to_string(),
                    text: "甲乙丙丁戊".to_string(),
                },
                LiteraryChapterDraft {
                    id: "new-c2".to_string(),
                    volume: None,
                    title: "第二章".to_string(),
                    text: "新章".to_string(),
                },
            ],
        })
        .unwrap();

        assert_eq!(replaced.preserved_chapter_count, 1);
        assert_eq!(replaced.chapter_count, 2);
        let preserved: LiteraryStudyFile =
            serde_json::from_str(&std::fs::read_to_string(&replaced.first_chapter_path).unwrap())
                .unwrap();
        assert_eq!(preserved.book.title, "修订版");
        assert_eq!(preserved.source_cursor, 2);
        assert_eq!(preserved.insertions.len(), 1);
        let overview = read_literary_study_overview_inner(&created.project_path).unwrap();
        assert_eq!(overview.copied_characters, 2);
        assert_eq!(overview.chapter_count, 2);
    }

    #[test]
    fn replacement_collision_restores_original_project() {
        let parent = tempfile::tempdir().unwrap();
        let created = create_literary_study_project_inner(CreateLiteraryStudyProjectRequest {
            project_name: "回滚测试".to_string(),
            parent_dir: parent.path().to_string_lossy().to_string(),
            source_path: "/tmp/original.txt".to_string(),
            title: "原书".to_string(),
            author: None,
            language: Some("zh-CN".to_string()),
            chapters: vec![LiteraryChapterDraft {
                id: "c1".to_string(),
                volume: None,
                title: "第一章".to_string(),
                text: "原始正文".to_string(),
            }],
        })
        .unwrap();
        let original_chapter = std::fs::read(&created.first_chapter_path).unwrap();
        let metadata_path = Path::new(&created.project_path)
            .join(".novelist")
            .join(LITERARY_METADATA_FILE);
        let original_metadata = std::fs::read(&metadata_path).unwrap();
        let collision = Path::new(&created.project_path)
            .join(LITERARY_CONTENT_ROOT)
            .join("章节")
            .join("0002 第二章.litstudy");
        std::fs::write(&collision, b"unmanaged").unwrap();

        let error = replace_literary_study_book_inner(ReplaceLiteraryStudyBookRequest {
            project_dir: created.project_path.clone(),
            source_path: "/tmp/replacement.txt".to_string(),
            title: "新书".to_string(),
            author: None,
            language: Some("zh-CN".to_string()),
            chapters: vec![
                LiteraryChapterDraft {
                    id: "new-c1".to_string(),
                    volume: None,
                    title: "第一章".to_string(),
                    text: "替换正文".to_string(),
                },
                LiteraryChapterDraft {
                    id: "new-c2".to_string(),
                    volume: None,
                    title: "第二章".to_string(),
                    text: "会发生冲突".to_string(),
                },
            ],
        })
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("collides with an unmanaged file"));
        assert_eq!(
            std::fs::read(&created.first_chapter_path).unwrap(),
            original_chapter
        );
        assert_eq!(std::fs::read(&metadata_path).unwrap(), original_metadata);
        assert_eq!(std::fs::read(&collision).unwrap(), b"unmanaged");
        let novelist_dir = Path::new(&created.project_path).join(".novelist");
        let leftovers = std::fs::read_dir(novelist_dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| {
                name.starts_with(".literary-stage-") || name.starts_with(".literary-backup-")
            })
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn rejects_excessive_chapter_counts_before_writing() {
        let chapters = (0..=MAX_LITERARY_CHAPTERS)
            .map(|index| LiteraryChapterDraft {
                id: format!("c{index}"),
                volume: None,
                title: format!("第{index}章"),
                text: "正文".to_string(),
            })
            .collect::<Vec<_>>();
        let error = validate_book_request("书", &chapters, "empty").unwrap_err();
        assert!(error.to_string().contains("support at most 4096 chapters"));
    }

    #[test]
    fn replacing_changed_prefix_resets_incompatible_progress() {
        let mut replacement = LiteraryStudyFile {
            schema_version: 1,
            book: LiteraryBook {
                title: "书".to_string(),
                author: None,
                language: None,
            },
            chapter: LiteraryChapter {
                id: "new".to_string(),
                title: "第一章".to_string(),
                volume: None,
                index: 1,
                total: 1,
                previous_path: None,
                next_path: None,
            },
            source: "甲新丙".to_string(),
            source_cursor: 0,
            insertions: Vec::new(),
            stats: LiteraryStats {
                correct: 0,
                mistakes: 0,
                pasted: 0,
                started_at: None,
                completed_at: None,
            },
        };
        let mut previous = replacement.clone();
        previous.source = "甲乙丙".to_string();
        previous.source_cursor = 2;
        previous.stats.correct = 2;
        previous.stats.started_at = Some("2026-08-04T00:00:00Z".to_string());

        assert!(!preserve_compatible_progress(&mut replacement, &previous));
        assert_eq!(replacement.source_cursor, 0);
        assert!(replacement.stats.started_at.is_none());
    }

    #[test]
    fn inspects_minimal_epub() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("book.epub");
        let file = File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("META-INF/container.xml", options).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
        zip.start_file("OEBPS/content.opf", options).unwrap();
        zip.write_all(
            r#"<?xml version="1.0"?><package><metadata><dc:title xmlns:dc="dc">测试书</dc:title><dc:creator xmlns:dc="dc">作者</dc:creator></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>"#
                .as_bytes(),
        )
        .unwrap();
        zip.start_file("OEBPS/chapter.xhtml", options).unwrap();
        zip.write_all(r#"<html><body><h1>第一章</h1><p>正文</p></body></html>"#.as_bytes())
            .unwrap();
        zip.finish().unwrap();

        let inspected = inspect_epub(&path).unwrap();
        assert_eq!(inspected.title, "测试书");
        assert_eq!(inspected.author.as_deref(), Some("作者"));
        assert_eq!(inspected.chapters.len(), 1);
        assert_eq!(inspected.chapters[0].text, "正文");
    }

    #[test]
    #[ignore = "requires NOVELIST_LITERARY_FIXTURE to point to a local EPUB"]
    fn inspects_external_epub_fixture() {
        let path = std::env::var("NOVELIST_LITERARY_FIXTURE")
            .expect("set NOVELIST_LITERARY_FIXTURE to an EPUB path");
        let inspected = inspect_epub(Path::new(&path)).unwrap();
        println!(
            "title={} author={:?} chapters={} first={} first_chars={}",
            inspected.title,
            inspected.author,
            inspected.chapters.len(),
            inspected.chapters[0].title,
            inspected.chapters[0]
                .text
                .chars()
                .take(80)
                .collect::<String>()
        );
        assert!(!inspected.title.is_empty());
        assert!(!inspected.chapters.is_empty());
    }

    #[test]
    #[ignore = "requires NOVELIST_LITERARY_FIXTURE and NOVELIST_LITERARY_DEMO_PARENT"]
    fn builds_external_demo_project() {
        let source_path = std::env::var("NOVELIST_LITERARY_FIXTURE")
            .expect("set NOVELIST_LITERARY_FIXTURE to an EPUB path");
        let parent_dir = std::env::var("NOVELIST_LITERARY_DEMO_PARENT")
            .expect("set NOVELIST_LITERARY_DEMO_PARENT to an existing directory");
        let inspected = inspect_epub(Path::new(&source_path)).unwrap();
        let result = create_literary_study_project_inner(CreateLiteraryStudyProjectRequest {
            project_name: "雪中悍刀行-文学评注".to_string(),
            parent_dir,
            source_path,
            title: inspected.title,
            author: inspected.author,
            language: inspected.language,
            chapters: inspected.chapters,
        })
        .unwrap();
        println!(
            "project={} chapters={} first={}",
            result.project_path, result.chapter_count, result.first_chapter_path
        );
        assert!(result.first_chapter_path.contains("第一章"));
    }
}
