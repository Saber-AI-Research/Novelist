//! Android logcat sink for the existing `tracing` output and panic messages.
//!
//! Android discards a process's stdout/stderr, so without this the startup,
//! setup and IPC diagnostics (and panic messages) of a phone build are lost.
//! Records go to `liblog` under the tag `Novelist`; nothing else is collected
//! or sent anywhere. Formatting (including redaction) is unchanged: this only
//! replaces where the formatted text is written.

use std::ffi::{c_char, c_int};
use std::io;
use tracing::{Level, Metadata};
use tracing_subscriber::fmt::MakeWriter;

#[link(name = "log")]
extern "C" {
    fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
}

const TAG: &[u8] = b"Novelist\0";
// android/log.h priorities.
const VERBOSE: c_int = 2;
const DEBUG: c_int = 3;
const INFO: c_int = 4;
const WARN: c_int = 5;
const ERROR: c_int = 6;
/// Bytes per logcat record, below liblog's ~4 KiB payload limit. Longer
/// output is split into consecutive records at UTF-8 boundaries.
const RECORD: usize = 4000;

/// `MakeWriter` for `tracing_subscriber::fmt` that maps the event level to
/// the logcat priority.
pub struct Logcat;

impl<'a> MakeWriter<'a> for Logcat {
    type Writer = LogcatWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogcatWriter::new(INFO)
    }

    fn make_writer_for(&'a self, meta: &Metadata<'_>) -> Self::Writer {
        let level = *meta.level();
        let priority = if level == Level::ERROR {
            ERROR
        } else if level == Level::WARN {
            WARN
        } else if level == Level::INFO {
            INFO
        } else if level == Level::DEBUG {
            DEBUG
        } else {
            VERBOSE
        };
        LogcatWriter::new(priority)
    }
}

/// Buffers one formatted record in a fixed stack buffer (no allocation) and
/// writes it to logcat on drop or flush.
pub struct LogcatWriter {
    priority: c_int,
    len: usize,
    buf: [u8; RECORD + 1],
}

impl LogcatWriter {
    fn new(priority: c_int) -> Self {
        Self {
            priority,
            len: 0,
            buf: [0; RECORD + 1],
        }
    }

    /// Write `buf[..end]` as one record (trailing newlines dropped: logcat
    /// separates records itself).
    fn write_record(&mut self, end: usize) {
        let saved = self.buf[end];
        let mut text_end = end;
        while text_end > 0 && matches!(self.buf[text_end - 1], b'\n' | b'\r') {
            text_end -= 1;
        }
        if text_end > 0 {
            let terminator = self.buf[text_end];
            self.buf[text_end] = 0;
            // SAFETY: TAG and `buf[..=text_end]` are NUL-terminated, and
            // interior NULs were replaced on write, so both are C strings.
            unsafe {
                __android_log_write(self.priority, TAG.as_ptr().cast(), self.buf.as_ptr().cast());
            }
            self.buf[text_end] = terminator;
        }
        self.buf[end] = saved;
    }

    /// Emit the full buffer up to its last complete UTF-8 character and keep
    /// the incomplete tail for the next record.
    fn emit_full(&mut self) {
        let len = self.len;
        let mut lead = len - 1;
        while lead > 0 && len - lead < 4 && self.buf[lead] & 0xC0 == 0x80 {
            lead -= 1;
        }
        let width = match self.buf[lead] {
            0xF0.. => 4,
            0xE0.. => 3,
            0xC0.. => 2,
            _ => 1,
        };
        let cut = if lead == 0 || lead + width <= len {
            len
        } else {
            lead
        };
        self.write_record(cut);
        self.buf.copy_within(cut..len, 0);
        self.len = len - cut;
    }

    fn emit(&mut self) {
        if self.len > 0 {
            self.write_record(self.len);
            self.len = 0;
        }
    }
}

impl io::Write for LogcatWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut rest = bytes;
        while !rest.is_empty() {
            if self.len == RECORD {
                self.emit_full();
            }
            let take = (RECORD - self.len).min(rest.len());
            for (dst, &src) in self.buf[self.len..self.len + take].iter_mut().zip(rest) {
                // An interior NUL would silently cut the record short.
                *dst = if src == 0 { b' ' } else { src };
            }
            self.len += take;
            rest = &rest[take..];
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.emit();
        Ok(())
    }
}

impl Drop for LogcatWriter {
    fn drop(&mut self) {
        self.emit();
    }
}

/// Also send panic messages (setup failures, crashes) to logcat; the previous
/// hook still runs afterwards.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        let mut writer = LogcatWriter::new(ERROR);
        let _ = write!(writer, "{info}");
        drop(writer);
        previous(info);
    }));
}
