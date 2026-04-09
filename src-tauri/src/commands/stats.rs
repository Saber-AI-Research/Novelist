use crate::error::AppError;
use crate::services::writing_stats::{self, WritingStatsOverview};
use serde::Deserialize;
use specta::Type;

#[derive(Deserialize, Type)]
pub struct ChapterStatsInput {
    pub file_name: String,
    pub file_path: String,
    pub word_count: usize,
}

#[tauri::command]
#[specta::specta]
pub async fn record_writing_stats(
    project_dir: String,
    word_delta: i64,
    minutes: u64,
) -> Result<(), AppError> {
    writing_stats::record_words(&project_dir, word_delta, minutes).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_writing_stats(
    project_dir: String,
    chapters: Vec<ChapterStatsInput>,
) -> Result<WritingStatsOverview, AppError> {
    let chapter_files: Vec<(String, String, usize)> = chapters
        .into_iter()
        .map(|c| (c.file_name, c.file_path, c.word_count))
        .collect();
    writing_stats::get_stats_overview(&project_dir, chapter_files).await
}
