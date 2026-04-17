use crate::error::AppError;
use crate::models::template::{TemplateInfo, TemplateMeta};
use std::path::{Path, PathBuf};

/// Returns the base directory for user templates: ~/.novelist/templates/
fn templates_dir() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::Custom("Cannot determine home directory".into()))?;
    Ok(home.join(".novelist").join("templates"))
}

/// Built-in templates that are always available (generated in-memory, not on disk).
fn builtin_templates() -> Vec<TemplateInfo> {
    vec![
        TemplateInfo {
            id: "blank".into(),
            name: "Blank".into(),
            description: "Empty project with default settings".into(),
            category: "general".into(),
            builtin: true,
        },
        TemplateInfo {
            id: "novel".into(),
            name: "Novel".into(),
            description: "Novel project with chapter structure".into(),
            category: "fiction".into(),
            builtin: true,
        },
        TemplateInfo {
            id: "long-novel".into(),
            name: "长篇小说".into(),
            description: "Multi-volume novel with character profiles, world-building notes, and chapter folders".into(),
            category: "fiction".into(),
            builtin: true,
        },
        TemplateInfo {
            id: "short-story".into(),
            name: "短篇小说".into(),
            description: "Short story with a single manuscript file and planning notes".into(),
            category: "fiction".into(),
            builtin: true,
        },
        TemplateInfo {
            id: "screenplay".into(),
            name: "剧本".into(),
            description: "Three-act screenplay with character list and scene structure".into(),
            category: "fiction".into(),
            builtin: true,
        },
        TemplateInfo {
            id: "blog".into(),
            name: "Blog".into(),
            description: "Blog with posts and drafts folders".into(),
            category: "non-fiction".into(),
            builtin: true,
        },
        TemplateInfo {
            id: "journal".into(),
            name: "Journal".into(),
            description: "Daily journal with date-based files".into(),
            category: "personal".into(),
            builtin: true,
        },
    ]
}

#[tauri::command]
#[specta::specta]
pub async fn list_templates() -> Result<Vec<TemplateInfo>, AppError> {
    let mut templates = builtin_templates();

    let dir = templates_dir()?;
    if dir.exists() {
        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let meta_path = path.join("template.toml");
            if meta_path.exists() {
                let content = tokio::fs::read_to_string(&meta_path).await?;
                if let Ok(meta) = toml::from_str::<TemplateMeta>(&content) {
                    templates.push(TemplateInfo {
                        id: meta.id,
                        name: meta.name,
                        description: meta.description,
                        category: meta.category,
                        builtin: false,
                    });
                }
            }
        }
    }

    Ok(templates)
}

/// Scaffolds a built-in template into the given directory.
fn scaffold_builtin(
    template_id: &str,
    project_name: &str,
    dest: &Path,
) -> Result<String, AppError> {
    let novelist_dir = dest.join(".novelist");
    std::fs::create_dir_all(&novelist_dir)?;

    let project_type = match template_id {
        "novel" | "long-novel" | "short-story" | "screenplay" => "novel",
        "blog" => "blog",
        "journal" => "journal",
        _ => "novel",
    };

    let config = format!(
        r#"[project]
name = "{name}"
type = "{ptype}"
version = "0.1.0"

[writing]
daily_goal = 2000
auto_save_minutes = 5
"#,
        name = project_name,
        ptype = project_type,
    );
    std::fs::write(novelist_dir.join("project.toml"), &config)?;

    match template_id {
        "novel" => {
            std::fs::write(dest.join("Chapter 1.md"), format!("# {}\n\n", project_name))?;
            std::fs::write(dest.join("Chapter 2.md"), "# Chapter 2\n\n")?;
            std::fs::write(dest.join("Chapter 3.md"), "# Chapter 3\n\n")?;
            // Set outline order
            let outline_config = format!(
                r#"[project]
name = "{name}"
type = "novel"
version = "0.1.0"

[outline]
order = ["Chapter 1.md", "Chapter 2.md", "Chapter 3.md"]

[writing]
daily_goal = 2000
auto_save_minutes = 5
"#,
                name = project_name,
            );
            std::fs::write(novelist_dir.join("project.toml"), &outline_config)?;
        }
        "long-novel" => {
            // Planning files
            std::fs::write(
                dest.join("大纲.md"),
                "# 大纲\n\n## 故事梗概\n\n\n\n## 主题\n\n\n\n## 故事线\n\n### 主线\n\n\n\n### 副线\n\n\n",
            )?;
            std::fs::write(
                dest.join("人物设定.md"),
                "# 人物设定\n\n## 主角\n\n**姓名**：\n\n**年龄**：\n\n**性格**：\n\n**背景**：\n\n---\n\n## 配角\n\n\n\n---\n\n## 反派\n\n\n",
            )?;
            std::fs::write(
                dest.join("世界观.md"),
                "# 世界观\n\n## 时代背景\n\n\n\n## 地理环境\n\n\n\n## 社会结构\n\n\n\n## 重要设定\n\n\n",
            )?;
            // Volume 1
            let vol1 = dest.join("第一卷");
            std::fs::create_dir_all(&vol1)?;
            std::fs::write(vol1.join("第一章.md"), "# 第一章\n\n")?;
            std::fs::write(vol1.join("第二章.md"), "# 第二章\n\n")?;
            std::fs::write(vol1.join("第三章.md"), "# 第三章\n\n")?;
            // Volume 2
            let vol2 = dest.join("第二卷");
            std::fs::create_dir_all(&vol2)?;
            std::fs::write(vol2.join("第四章.md"), "# 第四章\n\n")?;
            std::fs::write(vol2.join("第五章.md"), "# 第五章\n\n")?;

            let outline_config = format!(
                r#"[project]
name = "{name}"
type = "novel"
version = "0.1.0"

[outline]
order = ["大纲.md", "人物设定.md", "世界观.md"]

[writing]
daily_goal = 2000
auto_save_minutes = 5
"#,
                name = project_name,
            );
            std::fs::write(novelist_dir.join("project.toml"), &outline_config)?;
        }
        "short-story" => {
            std::fs::write(dest.join("正文.md"), format!("# {}\n\n", project_name))?;
            std::fs::write(
                dest.join("创作笔记.md"),
                "# 创作笔记\n\n## 灵感来源\n\n\n\n## 核心冲突\n\n\n\n## 人物速写\n\n\n\n## 结局构想\n\n\n",
            )?;

            let outline_config = format!(
                r#"[project]
name = "{name}"
type = "novel"
version = "0.1.0"

[outline]
order = ["正文.md", "创作笔记.md"]

[writing]
daily_goal = 1000
auto_save_minutes = 5
"#,
                name = project_name,
            );
            std::fs::write(novelist_dir.join("project.toml"), &outline_config)?;
        }
        "screenplay" => {
            std::fs::write(
                dest.join("人物表.md"),
                "# 人物表\n\n## 主要人物\n\n**角色名**：\n**身份**：\n**简介**：\n\n---\n\n## 次要人物\n\n\n",
            )?;
            std::fs::write(
                dest.join("第一幕.md"),
                "# 第一幕\n\n## 场景一\n\n**场景**：\n**时间**：\n\n---\n\n",
            )?;
            std::fs::write(
                dest.join("第二幕.md"),
                "# 第二幕\n\n## 场景一\n\n**场景**：\n**时间**：\n\n---\n\n",
            )?;
            std::fs::write(
                dest.join("第三幕.md"),
                "# 第三幕\n\n## 场景一\n\n**场景**：\n**时间**：\n\n---\n\n",
            )?;

            let outline_config = format!(
                r#"[project]
name = "{name}"
type = "novel"
version = "0.1.0"

[outline]
order = ["人物表.md", "第一幕.md", "第二幕.md", "第三幕.md"]

[writing]
daily_goal = 1500
auto_save_minutes = 5
"#,
                name = project_name,
            );
            std::fs::write(novelist_dir.join("project.toml"), &outline_config)?;
        }
        "blog" => {
            std::fs::create_dir_all(dest.join("posts"))?;
            std::fs::create_dir_all(dest.join("drafts"))?;
            std::fs::write(
                dest.join("posts").join("first-post.md"),
                "# My First Post\n\n",
            )?;
        }
        "journal" => {
            let today = chrono_today();
            let filename = format!("{}.md", today);
            std::fs::write(dest.join(&filename), format!("# {}\n\n", today))?;
        }
        _ => {
            // Blank — just the .novelist config is enough
        }
    }

    Ok(dest.to_string_lossy().to_string())
}

/// Returns today's date as YYYY-MM-DD without pulling in chrono.
fn chrono_today() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple date calculation
    let days = now / 86400;
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let month_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 1u32;
    for &md in &month_days {
        if remaining < md {
            break;
        }
        remaining -= md;
        m += 1;
    }
    let d = remaining + 1;
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

#[tauri::command]
#[specta::specta]
pub async fn create_project_from_template(
    template_id: String,
    project_name: String,
    parent_dir: String,
) -> Result<String, AppError> {
    let dest = Path::new(&parent_dir).join(&project_name);
    if dest.exists() {
        return Err(AppError::InvalidInput(format!(
            "Directory already exists: {}",
            dest.display()
        )));
    }
    std::fs::create_dir_all(&dest)?;

    // Check if it's a built-in template
    let builtins: Vec<&str> = vec![
        "blank",
        "novel",
        "long-novel",
        "short-story",
        "screenplay",
        "blog",
        "journal",
    ];
    if builtins.contains(&template_id.as_str()) {
        return scaffold_builtin(&template_id, &project_name, &dest);
    }

    // User template: copy .novelist/ directory from template
    let tpl_dir = templates_dir()?.join(&template_id);
    let novelist_src = tpl_dir.join(".novelist");
    if !novelist_src.exists() {
        return Err(AppError::FileNotFound(format!(
            "Template .novelist dir not found: {}",
            novelist_src.display()
        )));
    }

    // Copy the .novelist directory
    let novelist_dest = dest.join(".novelist");
    copy_dir_recursive(&novelist_src, &novelist_dest)?;

    // Override project name in project.toml
    let config_path = novelist_dest.join("project.toml");
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)?;
        if let Ok(mut config) = toml::from_str::<crate::models::project::ProjectConfig>(&content) {
            config.project.name = project_name.clone();
            let new_content = toml::to_string(&config)?;
            std::fs::write(&config_path, new_content)?;
        }
    }

    // Copy any non-.novelist files from template (sample chapters, etc.)
    copy_template_files(&tpl_dir, &dest)?;

    Ok(dest.to_string_lossy().to_string())
}

/// Recursively copy a directory.
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            std::fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

/// Copy non-.novelist files from template root to destination.
fn copy_template_files(tpl_dir: &Path, dest: &Path) -> Result<(), AppError> {
    for entry in std::fs::read_dir(tpl_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Skip .novelist dir and template.toml meta
        if name_str == ".novelist" || name_str == "template.toml" {
            continue;
        }
        let src_path = entry.path();
        let dest_path = dest.join(&name);
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            std::fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn save_project_as_template(
    project_dir: String,
    template_name: String,
) -> Result<TemplateInfo, AppError> {
    let src = Path::new(&project_dir);
    let novelist_src = src.join(".novelist");
    if !novelist_src.exists() {
        return Err(AppError::InvalidInput(
            "Not a Novelist project (no .novelist directory)".into(),
        ));
    }

    // Generate ID from name
    let id = template_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let id = id.trim_matches('-').to_string();
    if id.is_empty() {
        return Err(AppError::InvalidInput("Template name is empty".into()));
    }

    let tpl_dir = templates_dir()?.join(&id);
    if tpl_dir.exists() {
        return Err(AppError::InvalidInput(format!(
            "Template '{}' already exists",
            id
        )));
    }

    std::fs::create_dir_all(&tpl_dir)?;

    // Copy .novelist directory
    copy_dir_recursive(&novelist_src, &tpl_dir.join(".novelist"))?;

    // Copy sample files (non-hidden, non-.novelist)
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let src_path = entry.path();
        let dest_path = tpl_dir.join(&name);
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            std::fs::copy(&src_path, &dest_path)?;
        }
    }

    // Write template.toml
    let meta = TemplateMeta {
        id: id.clone(),
        name: template_name.clone(),
        description: String::new(),
        category: "custom".into(),
    };
    let toml_content = toml::to_string(&meta)?;
    std::fs::write(tpl_dir.join("template.toml"), toml_content)?;

    Ok(TemplateInfo {
        id,
        name: template_name,
        description: String::new(),
        category: "custom".into(),
        builtin: false,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn delete_template(template_id: String) -> Result<(), AppError> {
    let tpl_dir = templates_dir()?.join(&template_id);
    if !tpl_dir.exists() {
        return Err(AppError::FileNotFound(format!(
            "Template not found: {}",
            template_id
        )));
    }
    std::fs::remove_dir_all(&tpl_dir)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn import_template_zip(zip_path: String) -> Result<TemplateInfo, AppError> {
    let zip_file = Path::new(&zip_path);
    if !zip_file.exists() {
        return Err(AppError::FileNotFound(zip_path));
    }

    // Use the zip filename (without extension) as a temporary ID
    let stem = zip_file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported");

    // Create a temp dir, extract, then move to templates
    let tmp_dir = std::env::temp_dir().join(format!("novelist-import-{}", std::process::id()));
    std::fs::create_dir_all(&tmp_dir)?;

    // Extract zip using system unzip command
    let output = std::process::Command::new("unzip")
        .arg("-o")
        .arg(zip_file)
        .arg("-d")
        .arg(&tmp_dir)
        .output()?;

    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(AppError::Custom(format!(
            "Failed to extract zip: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    // Find the actual content root (might be nested in a single directory)
    let content_root = find_content_root(&tmp_dir)?;

    // Check for template.toml or .novelist directory
    let meta_path = content_root.join("template.toml");
    let novelist_dir = content_root.join(".novelist");

    let (id, name, description, category) = if meta_path.exists() {
        let content = std::fs::read_to_string(&meta_path)?;
        let meta: TemplateMeta = toml::from_str(&content)?;
        (meta.id, meta.name, meta.description, meta.category)
    } else if novelist_dir.exists() {
        // No template.toml but has .novelist — use zip stem as name
        let id = stem
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect::<String>();
        (id, stem.to_string(), String::new(), "custom".to_string())
    } else {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(AppError::InvalidInput(
            "Zip must contain a .novelist directory or template.toml".into(),
        ));
    };

    let tpl_dir = templates_dir()?.join(&id);
    if tpl_dir.exists() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(AppError::InvalidInput(format!(
            "Template '{}' already exists",
            id
        )));
    }

    // Move content to templates dir
    std::fs::create_dir_all(tpl_dir.parent().unwrap())?;
    copy_dir_recursive(&content_root, &tpl_dir)?;

    // Ensure template.toml exists
    if !tpl_dir.join("template.toml").exists() {
        let meta = TemplateMeta {
            id: id.clone(),
            name: name.clone(),
            description: description.clone(),
            category: category.clone(),
        };
        std::fs::write(tpl_dir.join("template.toml"), toml::to_string(&meta)?)?;
    }

    // Clean up temp dir
    let _ = std::fs::remove_dir_all(&tmp_dir);

    Ok(TemplateInfo {
        id,
        name,
        description,
        category,
        builtin: false,
    })
}

/// If a zip extracts to a single directory, use that as the root.
fn find_content_root(dir: &Path) -> Result<PathBuf, AppError> {
    let entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();

    // Skip __MACOSX directory
    let real_entries: Vec<_> = entries
        .iter()
        .filter(|e| e.file_name().to_string_lossy() != "__MACOSX")
        .collect();

    if real_entries.len() == 1 && real_entries[0].path().is_dir() {
        Ok(real_entries[0].path())
    } else {
        Ok(dir.to_path_buf())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_chrono_today() {
        let today = chrono_today();
        // Should be YYYY-MM-DD format
        assert_eq!(today.len(), 10);
        assert_eq!(&today[4..5], "-");
        assert_eq!(&today[7..8], "-");
    }

    #[tokio::test]
    async fn test_list_templates_includes_builtins() {
        let templates = list_templates().await.unwrap();
        assert!(templates.iter().any(|t| t.id == "blank"));
        assert!(templates.iter().any(|t| t.id == "novel"));
        assert!(templates.iter().any(|t| t.id == "long-novel"));
        assert!(templates.iter().any(|t| t.id == "short-story"));
        assert!(templates.iter().any(|t| t.id == "screenplay"));
        assert!(templates.iter().any(|t| t.id == "blog"));
        assert!(templates.iter().any(|t| t.id == "journal"));
    }

    #[tokio::test]
    async fn test_create_blank_project() {
        let dir = TempDir::new().unwrap();
        let parent = dir.path().to_string_lossy().to_string();
        let result = create_project_from_template("blank".into(), "TestProject".into(), parent)
            .await
            .unwrap();
        let project_dir = Path::new(&result);
        assert!(project_dir.join(".novelist").join("project.toml").exists());
    }

    #[tokio::test]
    async fn test_create_novel_project() {
        let dir = TempDir::new().unwrap();
        let parent = dir.path().to_string_lossy().to_string();
        let result = create_project_from_template("novel".into(), "MyNovel".into(), parent)
            .await
            .unwrap();
        let project_dir = Path::new(&result);
        assert!(project_dir.join("Chapter 1.md").exists());
        assert!(project_dir.join("Chapter 2.md").exists());
        assert!(project_dir.join(".novelist").join("project.toml").exists());
    }

    #[tokio::test]
    async fn test_create_long_novel_project() {
        let dir = TempDir::new().unwrap();
        let parent = dir.path().to_string_lossy().to_string();
        let result = create_project_from_template("long-novel".into(), "MyEpic".into(), parent)
            .await
            .unwrap();
        let project_dir = Path::new(&result);
        assert!(project_dir.join("大纲.md").exists());
        assert!(project_dir.join("人物设定.md").exists());
        assert!(project_dir.join("世界观.md").exists());
        assert!(project_dir.join("第一卷").join("第一章.md").exists());
        assert!(project_dir.join("第二卷").join("第四章.md").exists());
        assert!(project_dir.join(".novelist").join("project.toml").exists());
    }

    #[tokio::test]
    async fn test_create_short_story_project() {
        let dir = TempDir::new().unwrap();
        let parent = dir.path().to_string_lossy().to_string();
        let result = create_project_from_template("short-story".into(), "MyStory".into(), parent)
            .await
            .unwrap();
        let project_dir = Path::new(&result);
        assert!(project_dir.join("正文.md").exists());
        assert!(project_dir.join("创作笔记.md").exists());
        assert!(project_dir.join(".novelist").join("project.toml").exists());
    }

    #[tokio::test]
    async fn test_create_screenplay_project() {
        let dir = TempDir::new().unwrap();
        let parent = dir.path().to_string_lossy().to_string();
        let result = create_project_from_template("screenplay".into(), "MyScript".into(), parent)
            .await
            .unwrap();
        let project_dir = Path::new(&result);
        assert!(project_dir.join("人物表.md").exists());
        assert!(project_dir.join("第一幕.md").exists());
        assert!(project_dir.join("第二幕.md").exists());
        assert!(project_dir.join("第三幕.md").exists());
        assert!(project_dir.join(".novelist").join("project.toml").exists());
    }

    #[tokio::test]
    async fn test_create_duplicate_fails() {
        let dir = TempDir::new().unwrap();
        let parent = dir.path().to_string_lossy().to_string();
        create_project_from_template("blank".into(), "Dup".into(), parent.clone())
            .await
            .unwrap();
        let result = create_project_from_template("blank".into(), "Dup".into(), parent).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_save_and_delete_template() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("myproject");
        std::fs::create_dir_all(project.join(".novelist")).unwrap();
        std::fs::write(
            project.join(".novelist").join("project.toml"),
            "[project]\nname = \"Test\"\n",
        )
        .unwrap();
        std::fs::write(project.join("chapter.md"), "# Chapter\n").unwrap();

        let info = save_project_as_template(
            project.to_string_lossy().to_string(),
            "My Test Template".into(),
        )
        .await
        .unwrap();
        assert_eq!(info.name, "My Test Template");
        assert!(!info.builtin);

        // Verify it appears in list
        let templates = list_templates().await.unwrap();
        assert!(templates.iter().any(|t| t.id == info.id));

        // Delete it
        delete_template(info.id.clone()).await.unwrap();
        let templates = list_templates().await.unwrap();
        assert!(!templates.iter().any(|t| t.id == info.id));
    }
}
