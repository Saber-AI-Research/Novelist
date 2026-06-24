use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Extensions counted as narrative content for project-level word stats.
const COUNTED_EXTS: &[&str] = &["md", "txt", "json", "jsonl", "csv"];

/// CJK-aware word count. Mirrors `app/lib/utils/wordcount.ts`:
/// - each CJK scalar counts as 1 word
/// - runs of non-whitespace, non-CJK chars count as 1 Latin word
///
/// Rust `chars()` yields Unicode scalars, so supplementary-plane CJK works
/// without surrogate-pair handling.
pub fn count_words_cjk(text: &str) -> usize {
    if text.trim().is_empty() {
        return 0;
    }
    let mut count: usize = 0;
    let mut in_latin_word = false;
    for ch in text.chars() {
        if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' {
            if in_latin_word {
                count += 1;
                in_latin_word = false;
            }
            continue;
        }
        if is_cjk(ch as u32) {
            if in_latin_word {
                count += 1;
                in_latin_word = false;
            }
            count += 1;
            continue;
        }
        in_latin_word = true;
    }
    if in_latin_word {
        count += 1;
    }
    count
}

fn is_cjk(code: u32) -> bool {
    (0x4E00..=0x9FFF).contains(&code)        // CJK Unified Ideographs
        || (0x3400..=0x4DBF).contains(&code) // Extension A
        || (0xF900..=0xFAFF).contains(&code) // Compatibility Ideographs
        || (0x3000..=0x303F).contains(&code) // CJK Symbols and Punctuation
        || (0xFF00..=0xFFEF).contains(&code) // Fullwidth Forms
        || (0x20000..=0x2A6DF).contains(&code) // Extension B
        || (0x2A700..=0x2B73F).contains(&code) // Extension C
        || (0x2B740..=0x2B81F).contains(&code) // Extension D
        || (0x2B820..=0x2CEAF).contains(&code) // Extension E
        || (0x2CEB0..=0x2EBEF).contains(&code) // Extension F
        || (0x30000..=0x3134F).contains(&code) // Extension G
}

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
    let base = data_root();
    base.join("stats").join(short)
}

fn data_root() -> PathBuf {
    // `NOVELIST_STATS_DATA_DIR` is a test seam (used by unit tests that need
    // per-test isolation and can't rely on `portable::init()` having run).
    // Production code goes through `portable::novelist_home`.
    #[cfg(test)]
    {
        if let Ok(p) = std::env::var("NOVELIST_STATS_DATA_DIR") {
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
    }
    crate::services::portable::novelist_home().to_path_buf()
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

/// Recursively collect narrative files under `root`. Skips dot-prefixed entries
/// (hidden dirs like `.novelist`, recovery drafts like `*.~recovery`) and
/// returns (file_name, full_path) pairs.
///
/// Single-file mode passes a file path (not a directory) as the stats root, so
/// when `root` is a regular file we return it as the lone chapter rather than
/// trying to walk it as a directory.
fn collect_chapter_files(root: &Path) -> Vec<(String, String)> {
    if root.is_file() {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        return vec![(name, root.to_string_lossy().to_string())];
    }
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_s = name.to_string_lossy().to_string();
            if name_s.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                stack.push(path);
                continue;
            }
            let ext_ok = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| COUNTED_EXTS.iter().any(|c| c.eq_ignore_ascii_case(e)))
                .unwrap_or(false);
            if !ext_ok {
                continue;
            }
            out.push((name_s, path.to_string_lossy().to_string()));
        }
    }
    out
}

pub async fn get_stats_overview(project_dir: &str) -> Result<WritingStatsOverview, AppError> {
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

    // Walk the project directory ourselves so subfolder chapters are included
    // and word counts reflect on-disk content. Sequential file reads — fine for
    // typical novel projects (~100 files); revisit with caching if it bites.
    let files = collect_chapter_files(Path::new(project_dir));
    let mut chapters: Vec<ChapterStats> = Vec::with_capacity(files.len());
    let mut total_words: usize = 0;
    for (name, path) in files {
        let wc = match tokio::fs::read_to_string(&path).await {
            Ok(content) => count_words_cjk(&content),
            Err(_) => 0,
        };
        total_words += wc;
        chapters.push(ChapterStats {
            file_name: name,
            file_path: path,
            word_count: wc,
        });
    }

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
    use serial_test::serial;
    use tempfile::TempDir;

    fn set_data_dir(p: &std::path::Path) -> Option<std::ffi::OsString> {
        let old = std::env::var_os("NOVELIST_STATS_DATA_DIR");
        unsafe {
            std::env::set_var("NOVELIST_STATS_DATA_DIR", p);
        }
        old
    }

    fn restore_data_dir(old: Option<std::ffi::OsString>) {
        if let Some(v) = old {
            unsafe {
                std::env::set_var("NOVELIST_STATS_DATA_DIR", v);
            }
        } else {
            unsafe {
                std::env::remove_var("NOVELIST_STATS_DATA_DIR");
            }
        }
    }

    #[test]
    #[serial(stats_data_dir)]
    fn test_stats_dir_deterministic() {
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());
        let d1 = stats_dir("/home/user/novel");
        let d2 = stats_dir("/home/user/novel");
        assert_eq!(d1, d2);
        restore_data_dir(old);
    }

    #[test]
    #[serial(stats_data_dir)]
    fn test_stats_dir_different_for_different_projects() {
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());
        let d1 = stats_dir("/project-a");
        let d2 = stats_dir("/project-b");
        assert_ne!(d1, d2);
        restore_data_dir(old);
    }

    #[test]
    fn test_today_str_format() {
        let s = today_str();
        assert_eq!(s.len(), 10);
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[7..8], "-");
    }

    #[tokio::test]
    #[serial(stats_data_dir)]
    async fn test_record_and_read() {
        let data_tmp = TempDir::new().unwrap();
        let old = set_data_dir(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();

        record_words(&project, 100, 5).await.unwrap();
        record_words(&project, 50, 3).await.unwrap();

        let overview = get_stats_overview(&project).await.unwrap();
        assert_eq!(overview.today_words, 150);
        assert_eq!(overview.today_minutes, 8);

        restore_data_dir(old);
    }

    #[tokio::test]
    #[serial(stats_data_dir)]
    async fn test_chapter_stats_reads_files() {
        let data_tmp = TempDir::new().unwrap();
        let old = set_data_dir(data_tmp.path());

        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ch1.md"), "hello world foo").unwrap();
        std::fs::write(dir.path().join("ch2.md"), "你好世界").unwrap();
        // Subfolder content should also count.
        std::fs::create_dir(dir.path().join("part2")).unwrap();
        std::fs::write(dir.path().join("part2/ch3.md"), "abc def").unwrap();
        // Hidden dir + recovery drafts must be skipped.
        std::fs::create_dir(dir.path().join(".novelist")).unwrap();
        std::fs::write(dir.path().join(".novelist/notes.md"), "ignored").unwrap();
        std::fs::write(dir.path().join(".~recovery"), "ignored").unwrap();

        let project = dir.path().to_string_lossy().to_string();
        let overview = get_stats_overview(&project).await.unwrap();

        // 3 (ch1) + 4 (ch2 CJK) + 2 (ch3) = 9
        assert_eq!(overview.total_words, 9);
        assert_eq!(overview.chapters.len(), 3);

        restore_data_dir(old);
    }

    #[tokio::test]
    #[serial(stats_data_dir)]
    async fn test_single_file_stats_root() {
        // Single-file mode passes a file path (not a dir) as the stats root.
        let data_tmp = TempDir::new().unwrap();
        let old = set_data_dir(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let file = dir.path().join("draft.txt");
        std::fs::write(&file, "hello world 你好").unwrap();
        let file_path = file.to_string_lossy().to_string();

        let overview = get_stats_overview(&file_path).await.unwrap();
        // 2 latin words + 2 CJK chars = 4
        assert_eq!(overview.total_words, 4);
        assert_eq!(overview.chapters.len(), 1);
        assert_eq!(overview.chapters[0].file_name, "draft.txt");

        restore_data_dir(old);
    }

    #[test]
    fn test_count_words_cjk_empty() {
        assert_eq!(count_words_cjk(""), 0);
        assert_eq!(count_words_cjk("   \n\t"), 0);
    }

    #[test]
    fn test_count_words_cjk_latin() {
        assert_eq!(count_words_cjk("hello"), 1);
        assert_eq!(count_words_cjk("hello world foo bar"), 4);
        assert_eq!(count_words_cjk("  hello   world  "), 2);
    }

    #[test]
    fn test_count_words_cjk_chinese() {
        assert_eq!(count_words_cjk("你好世界"), 4);
        assert_eq!(count_words_cjk("第一章"), 3);
    }

    #[test]
    fn test_count_words_cjk_mixed() {
        // 4 CJK + 2 latin
        assert_eq!(count_words_cjk("你好世界 hello world"), 6);
    }

    #[test]
    fn test_count_words_cjk_supplementary_plane() {
        // U+20000 is Extension B — Rust `chars()` yields it as one scalar.
        assert_eq!(count_words_cjk("\u{20000}\u{20001}"), 2);
    }
}
