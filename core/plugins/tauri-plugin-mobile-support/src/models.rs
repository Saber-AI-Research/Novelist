use serde::{Deserialize, Serialize};

/// How the native share sheet closed. No variant claims the file was
/// delivered: share targets may queue, fail later, or never report back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareOutcome {
    /// iOS: the chosen activity reported completion (not proof of delivery).
    Completed,
    /// iOS: the user closed the sheet or cancelled the chosen activity.
    Cancelled,
    /// Android: the chooser closed; Android does not report whether a
    /// target was picked or the user backed out.
    Dismissed,
}
