use serde::{ser::Serializer, Serialize};

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Plugin errors. Messages never contain credential material: vault
/// failures collapse into the opaque [`Error::Vault`].
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Desktop builds: no native share sheet / vault backend.
    #[error("not supported on this platform")]
    Unsupported,
    /// An argument failed validation; the payload names the argument, never its value.
    #[error("invalid argument: {0}")]
    InvalidArgument(&'static str),
    /// The share path escapes the staging directory (traversal, symlink,
    /// hard link, or simply a different location).
    #[error("path is not inside the share staging directory")]
    PathNotAllowed,
    /// The share path is inside the staging directory but is not an existing regular file.
    #[error("share file is missing or not a regular file")]
    FileUnavailable,
    #[error("could not resolve the app cache directory")]
    CacheDirUnavailable,
    /// The native share sheet could not be shown or reported an error.
    #[error("share failed: {0}")]
    Share(String),
    /// Any native keychain/keystore failure. Intentionally opaque.
    #[error("credential vault operation failed")]
    Vault,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
