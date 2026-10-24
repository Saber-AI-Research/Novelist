use crate::services::sync::{self, SyncConfig, SyncStatus};
use crate::services::webdav;
use crate::AppError;
use serde::Serialize;
use specta::Type;

/// Placeholder the settings form shows instead of a stored password.
const MASKED_PASSWORD: &str = "****";

#[derive(Debug, Serialize, Type)]
pub struct SyncConfigMasked {
    pub enabled: bool,
    pub webdav_url: String,
    pub username: String,
    pub password: String,
    pub interval_minutes: u32,
    pub legacy_remote_acknowledged: bool,
}

impl From<SyncConfig> for SyncConfigMasked {
    fn from(c: SyncConfig) -> Self {
        Self {
            enabled: c.enabled,
            webdav_url: c.webdav_url,
            username: c.username,
            // An empty field must look empty, not like a stored password.
            password: if c.password.is_empty() {
                String::new()
            } else {
                MASKED_PASSWORD.to_string()
            },
            interval_minutes: c.interval_minutes,
            legacy_remote_acknowledged: c.legacy_remote_acknowledged,
        }
    }
}

/// Config files are small, but every read/write still runs off the async workers.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| AppError::Custom(format!("sync config worker: {error}")))?
}

/// Replace the form's masked password with the stored one, but only for the
/// same server and account: after the URL or username changes, the old
/// credentials must never be sent to the new host, so the password is empty.
fn resolve_masked_password(
    project_dir: &str,
    webdav_url: &str,
    username: &str,
    password: String,
) -> String {
    if password != MASKED_PASSWORD {
        return password;
    }
    match sync::read_sync_config(project_dir) {
        Ok(stored) if stored.webdav_url == webdav_url && stored.username == username => {
            stored.password
        }
        Ok(_) => String::new(),
        Err(error) => {
            tracing::warn!("stored sync config unreadable; masked password dropped: {error}");
            String::new()
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_sync_config(project_dir: String) -> Result<SyncConfigMasked, AppError> {
    blocking(move || sync::read_sync_config(&project_dir).map(Into::into)).await
}

#[tauri::command]
#[specta::specta]
pub async fn save_sync_config(project_dir: String, mut config: SyncConfig) -> Result<(), AppError> {
    blocking(move || {
        config.password = resolve_masked_password(
            &project_dir,
            &config.webdav_url,
            &config.username,
            std::mem::take(&mut config.password),
        );
        sync::save_sync_config_to_disk(&project_dir, &config)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn sync_now(project_dir: String) -> Result<SyncStatus, AppError> {
    sync::perform_sync(&project_dir).await
}

/// Join the namespace another device created when it migrated this project's
/// legacy WebDAV folder (`SyncStatus.adoptable_project_id`).
#[tauri::command]
#[specta::specta]
pub async fn adopt_sync_identity(project_dir: String, project_id: String) -> Result<(), AppError> {
    sync::adopt_legacy_identity(&project_dir, &project_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn test_sync_connection(
    project_dir: String,
    webdav_url: String,
    username: String,
    password: String,
) -> Result<bool, AppError> {
    let (url, user) = (webdav_url.clone(), username.clone());
    let password =
        blocking(move || Ok(resolve_masked_password(&project_dir, &url, &user, password))).await?;
    let client = reqwest::Client::new();
    let auth = webdav::WebDavAuth { username, password };
    webdav::test_connection(&client, &webdav_url, &auth).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::webdav::test_server::DavServer;
    use base64::Engine;
    use serial_test::serial;

    #[test]
    fn test_sync_config_masked_hides_password() {
        let config = SyncConfig {
            enabled: true,
            webdav_url: "https://dav.example.com".to_string(),
            username: "user".to_string(),
            password: "secret_password_123".to_string(),
            interval_minutes: 15,
            legacy_remote_acknowledged: true,
        };
        let masked: SyncConfigMasked = config.into();
        assert_eq!(masked.password, "****");
        assert_eq!(masked.username, "user");
        assert_eq!(masked.webdav_url, "https://dav.example.com");
        assert!(masked.enabled);
        assert_eq!(masked.interval_minutes, 15);
        assert!(masked.legacy_remote_acknowledged);
        let empty: SyncConfigMasked = SyncConfig::default().into();
        assert_eq!(empty.password, "");
    }

    /// Isolates the sync data directory for one test.
    struct SyncData {
        _dir: tempfile::TempDir,
        project: tempfile::TempDir,
        old: Option<std::ffi::OsString>,
    }

    impl SyncData {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let old = std::env::var_os("NOVELIST_SYNC_DATA_DIR");
            unsafe {
                std::env::set_var("NOVELIST_SYNC_DATA_DIR", dir.path());
            }
            Self {
                _dir: dir,
                project: tempfile::tempdir().unwrap(),
                old,
            }
        }

        fn project(&self) -> String {
            self.project.path().to_str().unwrap().to_string()
        }
    }

    impl Drop for SyncData {
        fn drop(&mut self) {
            unsafe {
                match &self.old {
                    Some(old) => std::env::set_var("NOVELIST_SYNC_DATA_DIR", old),
                    None => std::env::remove_var("NOVELIST_SYNC_DATA_DIR"),
                }
            }
        }
    }

    fn stored(url: &str) -> SyncConfig {
        SyncConfig {
            enabled: true,
            webdav_url: url.to_string(),
            username: "writer".to_string(),
            password: "stored-secret".to_string(),
            interval_minutes: 30,
            legacy_remote_acknowledged: false,
        }
    }

    fn sent_password(server: &DavServer) -> String {
        let state = server.state.lock().unwrap();
        let header = state.requests.last().unwrap().headers["authorization"].clone();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(header.strip_prefix("Basic ").unwrap())
            .unwrap();
        String::from_utf8(decoded).unwrap()
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn masked_password_is_reused_only_for_the_same_server_and_account() {
        let data = SyncData::new();
        let project = data.project();
        let old_server = DavServer::start();
        let new_server = DavServer::start();
        sync::save_sync_config_to_disk(&project, &stored(&old_server.url)).unwrap();

        // Reopened settings send the mask; the same host gets the stored password.
        assert!(test_sync_connection(
            project.clone(),
            old_server.url.clone(),
            "writer".into(),
            "****".into()
        )
        .await
        .unwrap());
        assert_eq!(sent_password(&old_server), "writer:stored-secret");

        // A changed URL or username never receives the old credentials.
        test_sync_connection(
            project.clone(),
            new_server.url.clone(),
            "writer".into(),
            "****".into(),
        )
        .await
        .unwrap();
        assert_eq!(sent_password(&new_server), "writer:");
        test_sync_connection(
            project.clone(),
            old_server.url.clone(),
            "other".into(),
            "****".into(),
        )
        .await
        .unwrap();
        assert_eq!(sent_password(&old_server), "other:");

        // An explicitly typed password is always used as typed.
        test_sync_connection(
            project.clone(),
            new_server.url.clone(),
            "writer".into(),
            "typed".into(),
        )
        .await
        .unwrap();
        assert_eq!(sent_password(&new_server), "writer:typed");
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn saving_a_new_url_with_the_mask_drops_the_stored_password() {
        let data = SyncData::new();
        let project = data.project();
        sync::save_sync_config_to_disk(&project, &stored("https://old.example.com/dav")).unwrap();

        let mut same = stored("https://old.example.com/dav");
        same.password = "****".into();
        save_sync_config(project.clone(), same).await.unwrap();
        assert_eq!(
            sync::read_sync_config(&project).unwrap().password,
            "stored-secret"
        );

        let mut moved = stored("https://new.example.com/dav");
        moved.password = "****".into();
        save_sync_config(project.clone(), moved).await.unwrap();
        let saved = sync::read_sync_config(&project).unwrap();
        assert_eq!(saved.webdav_url, "https://new.example.com/dav");
        assert_eq!(saved.password, "");
        assert_eq!(get_sync_config(project).await.unwrap().password, "");
    }
}
