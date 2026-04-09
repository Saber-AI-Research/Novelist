use serde::Serialize;
use specta::datatype::{DataType, Primitive};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("TOML parse error: {0}")]
    TomlParse(#[from] toml::de::Error),
    #[error("TOML serialize error: {0}")]
    TomlSerialize(#[from] toml::ser::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("Not a directory: {0}")]
    NotADirectory(String),
    #[error("Path not allowed: {0}")]
    PathNotAllowed(String),
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("{0}")]
    Custom(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl specta::Type for AppError {
    fn definition(_types: &mut specta::Types) -> DataType {
        DataType::Primitive(Primitive::str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = AppError::FileNotFound("/tmp/test.md".to_string());
        assert_eq!(err.to_string(), "File not found: /tmp/test.md");

        let err = AppError::NotADirectory("/tmp/file.txt".to_string());
        assert_eq!(err.to_string(), "Not a directory: /tmp/file.txt");

        let err = AppError::Custom("something went wrong".to_string());
        assert_eq!(err.to_string(), "something went wrong");
    }

    #[test]
    fn test_error_serialize() {
        let err = AppError::FileNotFound("/tmp/test.md".to_string());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"File not found: /tmp/test.md\"");
    }

    #[test]
    fn test_io_error_conversion() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "not found");
        let app_err: AppError = io_err.into();
        assert!(app_err.to_string().contains("not found"));
    }

    #[test]
    fn test_toml_parse_error_conversion() {
        let result: Result<toml::Value, _> = toml::from_str("{{invalid}}");
        let toml_err = result.unwrap_err();
        let app_err: AppError = toml_err.into();
        assert!(app_err.to_string().contains("TOML parse error"));
    }
}
