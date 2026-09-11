//! Portable project content included in snapshots and WebDAV sync.
//!
//! Project identity and literary source metadata are explicitly included;
//! credentials, caches, temporary transactions and unrelated dotfiles are not.
use std::path::{Component, Path};

pub(crate) fn is_project_content_path(relative: &Path) -> bool {
    let mut components = relative.components();
    let Some(Component::Normal(first)) = components.next() else {
        return false;
    };
    if first == ".novelist" {
        return matches!(components.next(), Some(Component::Normal(name))
            if name == "project.toml" || name == "literary-study.json")
            && components.next().is_none();
    }
    if first.to_string_lossy().starts_with('.')
        || components.any(|component| match component {
            Component::Normal(name) => name.to_string_lossy().starts_with('.'),
            _ => true,
        })
    {
        return false;
    }
    matches!(
        relative
            .extension()
            .and_then(|extension| extension.to_str()),
        Some(
            "md" | "markdown" | "txt" | "json" | "jsonl" | "csv" | "litstudy" | "canvas" | "kanban"
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_core_documents_and_required_project_metadata_only() {
        for relative in [
            "章节/第一章.md",
            "学习内容/第一章.litstudy",
            "规划/关系.canvas",
            "进度.kanban",
            ".novelist/project.toml",
            ".novelist/literary-study.json",
        ] {
            assert!(is_project_content_path(Path::new(relative)), "{relative}");
        }
        for relative in [
            "../越界.md",
            "/绝对.md",
            ".git/config",
            ".hidden.md",
            "章节/.secret/data.json",
            ".novelist/settings.json",
            ".novelist/sync-config.json",
            ".novelist/.literary-backup/book.litstudy",
            ".novelist/project.toml/child.md",
            "plugin.js",
        ] {
            assert!(!is_project_content_path(Path::new(relative)), "{relative}");
        }
    }
}
