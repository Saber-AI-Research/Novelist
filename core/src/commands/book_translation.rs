use crate::commands::literary_study::{
    sanitize_path_component, validate_project_name, LiteraryChapterDraft,
};
use crate::error::AppError;
use crate::models::project::{OutlineConfig, ProjectConfig, ProjectMeta, WritingConfig};
use crate::models::settings::PluginsConfig;
use crate::services::atomic_file::atomic_write_sync;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const ROOT: &str = "翻译内容";
const MAX_CHAPTER_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CHAPTERS: usize = 4096;

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateBookTranslationProjectRequest {
    pub project_name: String,
    pub parent_dir: String,
    pub source_path: String,
    pub title: String,
    pub author: Option<String>,
    pub source_language: Option<String>,
    pub target_language: String,
    pub chapters: Vec<LiteraryChapterDraft>,
}

#[derive(Debug, Clone, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateBookTranslationProjectResult {
    pub project_path: String,
    pub first_chapter_path: String,
    pub chapter_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSegment {
    pub id: String,
    pub source: String,
    pub translation: String,
    pub google_reference: Option<String>,
    pub llm_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookTranslationFile {
    pub schema_version: u32,
    pub book: BookTranslationBook,
    pub chapter: BookTranslationChapter,
    pub segments: Vec<TranslationSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookTranslationBook {
    pub title: String,
    pub author: Option<String>,
    pub source_language: Option<String>,
    pub target_language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookTranslationChapter {
    pub id: String,
    pub title: String,
    pub volume: Option<String>,
    pub index: usize,
    pub total: usize,
    pub previous_path: Option<String>,
    pub next_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookTranslationMetadata {
    schema_version: u32,
    source_path: String,
    title: String,
    author: Option<String>,
    source_language: Option<String>,
    target_language: String,
    chapter_count: usize,
    content_root: String,
    chapter_paths: Vec<String>,
}

fn valid_language(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// One segment per non-empty line. Both import sources put one paragraph per
/// line: the EPUB extractor ends every block element with a single `\n`, and
/// CJK TXT novels conventionally use one line per paragraph, so splitting only
/// on blank lines would collapse a whole chapter into one segment.
fn split_segments(text: &str) -> Vec<TranslationSegment> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .enumerate()
        .map(|(index, line)| TranslationSegment {
            id: format!("segment-{:04}", index + 1),
            source: line.to_string(),
            translation: String::new(),
            google_reference: None,
            llm_reference: None,
        })
        .collect()
}

/// Chapter files end with a newline, exactly like the plugin's serializer, so
/// re-publishing an unedited chapter is byte-identical.
fn chapter_bytes(file: &BookTranslationFile) -> Result<Vec<u8>, AppError> {
    let mut bytes = serde_json::to_vec_pretty(file)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn validate(request: &CreateBookTranslationProjectRequest) -> Result<(), AppError> {
    validate_project_name(&request.project_name)?;
    // `join` must only ever append one directory name to the chosen parent:
    // reject drive prefixes and anything else that is not a single component.
    let mut components = Path::new(&request.project_name).components();
    if !matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    ) {
        return Err(AppError::InvalidInput(
            "Project name cannot be empty or contain path separators".into(),
        ));
    }
    if request.title.trim().is_empty()
        || request.chapters.is_empty()
        || request.chapters.len() > MAX_CHAPTERS
    {
        return Err(AppError::InvalidInput(
            "A title and between 1 and 4096 chapters are required".into(),
        ));
    }
    if !valid_language(&request.target_language) {
        return Err(AppError::InvalidInput(
            "Target language must be a valid language code".into(),
        ));
    }
    if let Some(source) = &request.source_language {
        if !valid_language(source) {
            return Err(AppError::InvalidInput(
                "Source language must be a valid language code".into(),
            ));
        }
    }
    for chapter in &request.chapters {
        if chapter.title.trim().is_empty() || chapter.text.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "Chapter titles and text are required".into(),
            ));
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn create_book_translation_project(
    request: CreateBookTranslationProjectRequest,
) -> Result<CreateBookTranslationProjectResult, AppError> {
    tokio::task::spawn_blocking(move || create_inner(request))
        .await
        .map_err(|error| {
            AppError::Custom(format!("Book translation import task failed: {error}"))
        })?
}

fn create_inner(
    request: CreateBookTranslationProjectRequest,
) -> Result<CreateBookTranslationProjectResult, AppError> {
    validate(&request)?;
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
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // The staging name stays short and separator-free even for long CJK names.
    let temporary = parent.join(format!(
        ".{}.novelist-import-{}-{stamp}",
        sanitize_path_component(&request.project_name),
        std::process::id()
    ));
    std::fs::create_dir(&temporary)?;
    let result = build_project(&temporary, &request).and_then(|files| {
        std::fs::rename(&temporary, &destination)?;
        Ok(files)
    });
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    let files = result?;
    Ok(CreateBookTranslationProjectResult {
        project_path: destination.to_string_lossy().into(),
        first_chapter_path: destination.join(&files[0]).to_string_lossy().into(),
        chapter_count: files.len(),
    })
}

fn build_project(
    root: &Path,
    request: &CreateBookTranslationProjectRequest,
) -> Result<Vec<String>, AppError> {
    std::fs::create_dir(root.join(ROOT))?;
    std::fs::create_dir(root.join(".novelist"))?;
    let paths: Vec<String> = (0..request.chapters.len())
        .map(|index| format!("{ROOT}/{:04}.novtrans", index + 1))
        .collect();
    let book = BookTranslationBook {
        title: request.title.clone(),
        author: request.author.clone(),
        source_language: request.source_language.clone(),
        target_language: request.target_language.clone(),
    };
    for (index, chapter) in request.chapters.iter().enumerate() {
        let file = BookTranslationFile {
            schema_version: 1,
            book: book.clone(),
            chapter: BookTranslationChapter {
                id: chapter.id.clone(),
                title: chapter.title.clone(),
                volume: chapter.volume.clone(),
                index: index + 1,
                total: paths.len(),
                previous_path: index.checked_sub(1).map(|previous| paths[previous].clone()),
                next_path: paths.get(index + 1).cloned(),
            },
            segments: split_segments(&chapter.text),
        };
        let bytes = chapter_bytes(&file)?;
        if bytes.len() as u64 > MAX_CHAPTER_BYTES {
            return Err(AppError::InvalidInput(
                "Translation chapter is too large".into(),
            ));
        }
        atomic_write_sync(&root.join(&paths[index]), &bytes)?;
    }

    let mut plugins = PluginsConfig::default();
    plugins.enabled.insert("book-translation".into(), true);
    let config = ProjectConfig {
        project: ProjectMeta {
            name: request.project_name.trim().into(),
            project_type: "book-translation".into(),
            version: "0.1.0".into(),
        },
        outline: OutlineConfig {
            order: paths.clone(),
        },
        writing: WritingConfig::default(),
        view: Default::default(),
        new_file: Default::default(),
        plugins,
        snapshot: None,
        active_image_host_id: None,
    };
    atomic_write_sync(
        &root.join(".novelist/project.toml"),
        toml::to_string(&config)?.as_bytes(),
    )?;
    let metadata = BookTranslationMetadata {
        schema_version: 1,
        source_path: request.source_path.clone(),
        title: request.title.clone(),
        author: request.author.clone(),
        source_language: request.source_language.clone(),
        target_language: request.target_language.clone(),
        chapter_count: paths.len(),
        content_root: ROOT.into(),
        chapter_paths: paths.clone(),
    };
    atomic_write_sync(
        &root.join(".novelist/book-translation.json"),
        &serde_json::to_vec_pretty(&metadata)?,
    )?;
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::literary_study::inspect_literary_source;
    use std::io::Write;

    fn chapter(id: &str, title: &str, text: &str) -> LiteraryChapterDraft {
        LiteraryChapterDraft {
            id: id.into(),
            volume: None,
            title: title.into(),
            text: text.into(),
        }
    }

    fn request(
        parent: &Path,
        name: &str,
        chapters: Vec<LiteraryChapterDraft>,
    ) -> CreateBookTranslationProjectRequest {
        CreateBookTranslationProjectRequest {
            project_name: name.into(),
            parent_dir: parent.to_string_lossy().into(),
            source_path: "/books/source.epub".into(),
            title: "雪中悍刀行".into(),
            author: Some("烽火戏诸侯".into()),
            source_language: Some("zh-CN".into()),
            target_language: "en".into(),
            chapters,
        }
    }

    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn sources(text: &str) -> Vec<String> {
        split_segments(text)
            .into_iter()
            .map(|segment| segment.source)
            .collect()
    }

    #[test]
    fn splits_one_segment_per_non_empty_line() {
        assert_eq!(sources("Hello\n世界"), ["Hello", "世界"]);
        assert_eq!(sources("Hello\r\n\r\n  世界  \r\n\n"), ["Hello", "世界"]);
        // Full-width indentation of CJK paragraphs is not part of the source.
        assert_eq!(
            sources("　　第一段。\n　　第二段。"),
            ["第一段。", "第二段。"]
        );
        assert_eq!(
            split_segments("a\nb\nc")
                .iter()
                .map(|segment| segment.id.as_str())
                .collect::<Vec<_>>(),
            ["segment-0001", "segment-0002", "segment-0003"]
        );
    }

    #[tokio::test]
    async fn segments_real_txt_import_by_paragraph() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("novel.txt");
        std::fs::write(
            &path,
            "第一章 风起\n　　北凉王府龙盘虎踞。\n　　徐凤年回府了。\n　　老黄牵着马。\n第二章 雪落\n　　大雪。\n",
        )
        .unwrap();

        let inspected = inspect_literary_source(path.to_string_lossy().into())
            .await
            .unwrap();
        assert_eq!(inspected.chapters.len(), 2);
        assert_eq!(
            sources(&inspected.chapters[0].text),
            ["北凉王府龙盘虎踞。", "徐凤年回府了。", "老黄牵着马。"]
        );
        assert_eq!(sources(&inspected.chapters[1].text), ["大雪。"]);
    }

    #[tokio::test]
    async fn segments_real_epub_import_by_paragraph() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("book.epub");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("META-INF/container.xml", options).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
        zip.start_file("OEBPS/content.opf", options).unwrap();
        zip.write_all(
            r#"<?xml version="1.0"?><package><metadata><dc:title xmlns:dc="dc">Book</dc:title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>"#
                .as_bytes(),
        )
        .unwrap();
        zip.start_file("OEBPS/chapter.xhtml", options).unwrap();
        zip.write_all(
            "<html><body><h1>Chapter One</h1><p>It was a bright cold day.</p><p>The clocks were striking thirteen.</p><div><p>第三段。</p></div></body></html>"
                .as_bytes(),
        )
        .unwrap();
        zip.finish().unwrap();

        let inspected = inspect_literary_source(path.to_string_lossy().into())
            .await
            .unwrap();
        assert_eq!(inspected.chapters.len(), 1);
        assert_eq!(
            sources(&inspected.chapters[0].text),
            [
                "It was a bright cold day.",
                "The clocks were striking thirteen.",
                "第三段。"
            ]
        );
    }

    /// The plugin re-serializes chapters with `JSON.stringify(file, null, 2)`
    /// plus a newline (`tests/unit/plugins/book-translation-model.test.ts`
    /// checks the same fixture), so an unedited chapter round-trips unchanged.
    #[test]
    fn chapter_bytes_match_the_plugin_serializer() {
        let file = BookTranslationFile {
            schema_version: 1,
            book: BookTranslationBook {
                title: "Fate/Zero".into(),
                author: None,
                source_language: Some("ja".into()),
                target_language: "zh-CN".into(),
            },
            chapter: BookTranslationChapter {
                id: "chapter-0002".into(),
                title: "第二章 「聖杯」".into(),
                volume: Some("第一卷".into()),
                index: 2,
                total: 3,
                previous_path: Some("翻译内容/0001.novtrans".into()),
                next_path: Some("翻译内容/0003.novtrans".into()),
            },
            segments: vec![
                TranslationSegment {
                    id: "segment-0001".into(),
                    source: "「聖杯」と呼ばれる \"器\"。".into(),
                    translation: "被称为\"圣杯\"的器\n第二行".into(),
                    google_reference: None,
                    llm_reference: Some("Tab\there \\ back".into()),
                },
                TranslationSegment {
                    id: "segment-0002".into(),
                    source: "Second line.".into(),
                    translation: String::new(),
                    google_reference: Some("第二句。".into()),
                    llm_reference: None,
                },
            ],
        };
        assert_eq!(
            String::from_utf8(chapter_bytes(&file).unwrap()).unwrap(),
            include_str!("../../../tests/fixtures/book-translation/chapter.novtrans")
        );
    }

    #[test]
    fn validates_languages() {
        assert!(!valid_language(""));
        assert!(!valid_language("zh_CN"));
        assert!(valid_language("zh-CN"));
    }

    #[test]
    fn rejects_project_names_that_are_paths() {
        let parent = tempfile::tempdir().unwrap();
        for name in [
            "Fate/Zero",
            "./../escape",
            "..",
            ".",
            "a\\b",
            "nul\0byte",
            "",
            "   ",
        ] {
            let error = create_inner(request(
                parent.path(),
                name,
                vec![chapter("c1", "第一章", "正文")],
            ))
            .unwrap_err();
            assert!(
                matches!(error, AppError::InvalidInput(_)),
                "{name:?} gave {error:?}"
            );
        }
        assert!(entries(parent.path()).is_empty());
        assert!(!parent.path().parent().unwrap().join("escape").exists());
    }

    #[test]
    fn creates_linked_chapters_and_project_files() {
        let parent = tempfile::tempdir().unwrap();
        // 80 CJK characters: 240 bytes, within the name limit, but too long
        // for the staging folder unless its name is sanitized and truncated.
        let name = "译".repeat(80);
        let result = create_inner(request(
            parent.path(),
            &name,
            vec![
                chapter("c1", "第一章", "第一段。\n第二段。"),
                chapter("c2", "第二章", "第三段。"),
            ],
        ))
        .unwrap();

        let root = parent.path().join(&name);
        assert_eq!(entries(parent.path()), std::slice::from_ref(&name));
        assert_eq!(result.project_path, root.to_string_lossy());
        assert_eq!(result.chapter_count, 2);
        assert_eq!(
            result.first_chapter_path,
            root.join("翻译内容/0001.novtrans").to_string_lossy()
        );
        assert_eq!(
            entries(&root.join(ROOT)),
            ["0001.novtrans", "0002.novtrans"]
        );
        assert_eq!(
            entries(&root.join(".novelist")),
            ["book-translation.json", "project.toml"]
        );

        let first_raw = std::fs::read_to_string(root.join("翻译内容/0001.novtrans")).unwrap();
        assert!(first_raw.ends_with("}\n"));
        let first: BookTranslationFile = serde_json::from_str(&first_raw).unwrap();
        assert_eq!(first.segments.len(), 2);
        assert_eq!(first.chapter.previous_path, None);
        assert_eq!(
            first.chapter.next_path.as_deref(),
            Some("翻译内容/0002.novtrans")
        );
        let second: BookTranslationFile = serde_json::from_str(
            &std::fs::read_to_string(root.join("翻译内容/0002.novtrans")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            second.chapter.previous_path.as_deref(),
            Some("翻译内容/0001.novtrans")
        );
        assert_eq!(second.chapter.next_path, None);
        assert_eq!(second.chapter.total, 2);

        let config: ProjectConfig =
            toml::from_str(&std::fs::read_to_string(root.join(".novelist/project.toml")).unwrap())
                .unwrap();
        assert_eq!(config.project.project_type, "book-translation");
        assert_eq!(
            config.outline.order,
            ["翻译内容/0001.novtrans", "翻译内容/0002.novtrans"]
        );
        assert_eq!(config.plugins.enabled.get("book-translation"), Some(&true));
    }

    #[test]
    fn failed_import_leaves_nothing_behind() {
        let parent = tempfile::tempdir().unwrap();
        let oversized = "a".repeat(MAX_CHAPTER_BYTES as usize + 1);
        let error = create_inner(request(
            parent.path(),
            "Too large",
            vec![
                chapter("c1", "第一章", "正文"),
                chapter("c2", "第二章", &oversized),
            ],
        ))
        .unwrap_err();
        assert!(matches!(error, AppError::InvalidInput(_)));
        assert!(entries(parent.path()).is_empty());
    }
}
