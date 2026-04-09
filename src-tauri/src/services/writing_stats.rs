use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Type)]
pub struct DailyStats {
    pub date: String,
    pub words_written: i64,
    pub time_minutes: u64,
}

#[derive(Serialize, Deserialize, Clone, Type)]
pub struct ChapterStats {
    pub file_name: String,
    pub file_path: String,
    pub word_count: usize,
}

#[derive(Serialize, Deserialize, Clone, Type)]
pub struct WritingStatsOverview {
    pub daily: Vec<DailyStats>,
    pub total_words: usize,
    pub chapters: Vec<ChapterStats>,
    pub streak_days: u32,
    pub today_words: i64,
    pub today_minutes: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct DailyEntry {
    words_written: i64,
    time_minutes: u64,
}

type StatsMap = BTreeMap<String, DailyEntry>;

/// Get stats directory for a project, using a blake3 hash of the project path.
fn stats_dir(project_dir: &str) -> PathBuf {
    let hash = blake3::hash(project_dir.as_bytes());
    let hex = hash.to_hex();
    let short = &hex[..16];
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".novelist")
        .join("stats")
        .join(short)
}

fn stats_file(project_dir: &str) -> PathBuf {
    stats_dir(project_dir).join("daily.json")
}

fn today_str() -> String {
    let now = std::time::SystemTime::now();
    let dur = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    // Simple date calculation (UTC)
    let days = secs / 86400;
    let y;
    let m;
    let d;
    {
        // Civil date from days since epoch (algorithm from Howard Hinnant)
        let z = days + 719468;
        let era = if z >= 0 { z } else { z - 146096 } / 146097;
        let doe = (z - era * 146097) as u64;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        y = yoe as i64 + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = if mp < 10 { mp + 3 } else { mp - 9 };
        if m <= 2 {
            // year adjustment already handled below
        }
    }
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", year, m, d)
}

async fn read_stats(project_dir: &str) -> Result<StatsMap, AppError> {
    let path = stats_file(project_dir);
    if !path.exists() {
        return Ok(StatsMap::new());
    }
    let content = tokio::fs::read_to_string(&path).await?;
    let map: StatsMap = serde_json::from_str(&content)?;
    Ok(map)
}

async fn write_stats(project_dir: &str, map: &StatsMap) -> Result<(), AppError> {
    let path = stats_file(project_dir);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_string_pretty(map)?;
    let temp = format!("{}.tmp", path.display());
    tokio::fs::write(&temp, &json).await?;
    tokio::fs::rename(&temp, &path).await?;
    Ok(())
}

pub async fn record_words(
    project_dir: &str,
    word_delta: i64,
    minutes: u64,
) -> Result<(), AppError> {
    let mut map = read_stats(project_dir).await?;
    let today = today_str();
    let entry = map.entry(today).or_default();
    entry.words_written += word_delta;
    entry.time_minutes += minutes;
    write_stats(project_dir, &map).await
}

pub async fn get_stats_overview(
    project_dir: &str,
    chapter_files: Vec<(String, String, usize)>,
) -> Result<WritingStatsOverview, AppError> {
    let map = read_stats(project_dir).await?;
    let today = today_str();

    // Build last 30 days
    let all_dates: Vec<String> = {
        let mut dates = Vec::new();
        // Generate last 30 dates from today
        let now = std::time::SystemTime::now();
        let dur = now
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let today_days = dur.as_secs() / 86400;
        for i in (0..30).rev() {
            let d = today_days - i;
            let z = d as i64 + 719468;
            let era = if z >= 0 { z } else { z - 146096 } / 146097;
            let doe = (z - era * 146097) as u64;
            let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
            let y = yoe as i64 + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let dd = doy - (153 * mp + 2) / 5 + 1;
            let mm = if mp < 10 { mp + 3 } else { mp - 9 };
            let year = if mm <= 2 { y + 1 } else { y };
            dates.push(format!("{:04}-{:02}-{:02}", year, mm, dd));
        }
        dates
    };

    let daily: Vec<DailyStats> = all_dates
        .iter()
        .map(|date| {
            let entry = map.get(date).cloned().unwrap_or_default();
            DailyStats {
                date: date.clone(),
                words_written: entry.words_written,
                time_minutes: entry.time_minutes,
            }
        })
        .collect();

    // Today's stats
    let today_entry = map.get(&today).cloned().unwrap_or_default();

    // Streak: consecutive days ending today (or yesterday) with words_written > 0
    let streak_days = {
        let mut streak: u32 = 0;
        for ds in daily.iter().rev() {
            if ds.words_written > 0 {
                streak += 1;
            } else if streak == 0 {
                // Allow today to be 0 if we haven't written yet
                continue;
            } else {
                break;
            }
        }
        streak
    };

    // Total words from chapters
    let total_words: usize = chapter_files.iter().map(|(_, _, wc)| *wc).sum();

    let chapters: Vec<ChapterStats> = chapter_files
        .into_iter()
        .map(|(name, path, wc)| ChapterStats {
            file_name: name,
            file_path: path,
            word_count: wc,
        })
        .collect();

    Ok(WritingStatsOverview {
        daily,
        total_words,
        chapters,
        streak_days,
        today_words: today_entry.words_written,
        today_minutes: today_entry.time_minutes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_stats_dir_deterministic() {
        let d1 = stats_dir("/home/user/novel");
        let d2 = stats_dir("/home/user/novel");
        assert_eq!(d1, d2);
    }

    #[test]
    fn test_stats_dir_different_for_different_projects() {
        let d1 = stats_dir("/project-a");
        let d2 = stats_dir("/project-b");
        assert_ne!(d1, d2);
    }

    #[test]
    fn test_today_str_format() {
        let s = today_str();
        assert_eq!(s.len(), 10);
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[7..8], "-");
    }

    #[tokio::test]
    async fn test_record_and_read() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();

        record_words(&project, 100, 5).await.unwrap();
        record_words(&project, 50, 3).await.unwrap();

        let overview = get_stats_overview(&project, vec![]).await.unwrap();
        assert_eq!(overview.today_words, 150);
        assert_eq!(overview.today_minutes, 8);
    }

    #[tokio::test]
    async fn test_chapter_stats() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();

        let chapters = vec![
            ("ch1.md".to_string(), "/p/ch1.md".to_string(), 1000),
            ("ch2.md".to_string(), "/p/ch2.md".to_string(), 500),
        ];

        let overview = get_stats_overview(&project, chapters).await.unwrap();
        assert_eq!(overview.total_words, 1500);
        assert_eq!(overview.chapters.len(), 2);
    }
}
