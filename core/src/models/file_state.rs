use serde::Serialize;
use specta::Type;

#[derive(Debug, Serialize, Clone, Type)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Unix epoch milliseconds; None when filesystem doesn't expose mtime.
    pub mtime: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_entry_serialize() {
        let entry = FileEntry {
            name: "chapter1.md".to_string(),
            path: "/project/chapter1.md".to_string(),
            is_dir: false,
            size: 4096,
            mtime: None,
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["name"], "chapter1.md");
        assert_eq!(json["path"], "/project/chapter1.md");
        assert_eq!(json["is_dir"], false);
        assert_eq!(json["size"], 4096);
    }

    #[test]
    fn test_file_entry_dir() {
        let entry = FileEntry {
            name: "chapters".to_string(),
            path: "/project/chapters".to_string(),
            is_dir: true,
            size: 0,
            mtime: None,
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["is_dir"], true);
    }

    #[test]
    fn test_file_entry_clone() {
        let entry = FileEntry {
            name: "test.md".to_string(),
            path: "/test.md".to_string(),
            is_dir: false,
            size: 100,
            mtime: None,
        };
        let cloned = entry.clone();
        assert_eq!(entry.name, cloned.name);
        assert_eq!(entry.path, cloned.path);
        assert_eq!(entry.size, cloned.size);
    }

    #[test]
    fn test_file_entry_debug() {
        let entry = FileEntry {
            name: "test.md".to_string(),
            path: "/test.md".to_string(),
            is_dir: false,
            size: 0,
            mtime: None,
        };
        let debug = format!("{:?}", entry);
        assert!(debug.contains("test.md"));
        assert!(debug.contains("FileEntry"));
    }
}
