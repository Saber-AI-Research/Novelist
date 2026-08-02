use crate::commands::file::decode_bytes;
use crate::error::AppError;
use crate::models::project::{OutlineConfig, ProjectConfig, ProjectMeta, WritingConfig};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::ZipArchive;

const MAX_EPUB_ENTRIES: usize = 4096;
const MAX_EPUB_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryProjectMetadata {
    schema_version: u32,
    source_path: String,
    title: String,
    author: Option<String>,
    language: Option<String>,
    chapter_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryStudyFile<'a> {
    schema_version: u32,
    book: LiteraryBook<'a>,
    chapter: LiteraryChapter<'a>,
    source: &'a str,
    source_cursor: usize,
    insertions: Vec<LiteraryInsertion>,
    stats: LiteraryStats,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryBook<'a> {
    title: &'a str,
    author: Option<&'a str>,
    language: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryChapter<'a> {
    id: &'a str,
    title: &'a str,
    volume: Option<&'a str>,
    index: usize,
    total: usize,
    previous_path: Option<&'a str>,
    next_path: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiteraryInsertion {
    id: String,
    source_offset: usize,
    order: usize,
    kind: String,
    text: String,
}

#[derive(Debug, Serialize)]
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
    if request.title.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Book title cannot be empty".to_string(),
        ));
    }
    if request.chapters.is_empty() {
        return Err(AppError::InvalidInput(
            "Select at least one chapter".to_string(),
        ));
    }
    if request
        .chapters
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

    let relative_paths = chapter_relative_paths(&request.chapters);
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
        plugins: Default::default(),
        active_image_host_id: None,
    };
    std::fs::write(
        novelist_dir.join("project.toml"),
        toml::to_string(&project_config)?,
    )?;
    std::fs::write(
        novelist_dir.join("literary-study.json"),
        serde_json::to_string_pretty(&LiteraryProjectMetadata {
            schema_version: 1,
            source_path: request.source_path.clone(),
            title: request.title.trim().to_string(),
            author: request.author.clone(),
            language: request.language.clone(),
            chapter_count: request.chapters.len(),
        })?,
    )?;

    for (index, chapter) in request.chapters.iter().enumerate() {
        let relative = &relative_paths[index];
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let study = LiteraryStudyFile {
            schema_version: 1,
            book: LiteraryBook {
                title: request.title.trim(),
                author: request.author.as_deref(),
                language: request.language.as_deref(),
            },
            chapter: LiteraryChapter {
                id: &chapter.id,
                title: chapter.title.trim(),
                volume: chapter.volume.as_deref(),
                index: index + 1,
                total: request.chapters.len(),
                previous_path: index
                    .checked_sub(1)
                    .and_then(|previous| relative_paths.get(previous))
                    .map(String::as_str),
                next_path: relative_paths.get(index + 1).map(String::as_str),
            },
            source: chapter.text.trim(),
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
        std::fs::write(path, serde_json::to_string_pretty(&study)?)?;
    }
    Ok(relative_paths)
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
            if let Some(volume) = chapter
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
            }
        })
        .collect()
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
        assert!(first.contains("\"nextPath\": \"01 白马出凉州/0002 第二章.litstudy\""));
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
