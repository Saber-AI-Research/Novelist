use crate::error::AppError;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn atomic_write_sync(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Data path has no parent".to_string()))?;
    std::fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Data path has no file name".to_string()))?
        .to_string_lossy();
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for attempt in 0..32_u64 {
        let temporary = parent.join(format!(
            ".{file_name}.novelist-tmp-{}-{suffix}-{attempt}",
            std::process::id()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(mut file) => {
                let result = (|| -> Result<(), AppError> {
                    file.write_all(bytes)?;
                    file.flush()?;
                    file.sync_all()?;
                    Ok(())
                })();
                drop(file);
                if let Err(error) = result {
                    let _ = std::fs::remove_file(&temporary);
                    return Err(error);
                }
                if let Err(error) = std::fs::rename(&temporary, path) {
                    let _ = std::fs::remove_file(&temporary);
                    return Err(error.into());
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(AppError::InvalidInput(
        "Unable to allocate temporary file".to_string(),
    ))
}
