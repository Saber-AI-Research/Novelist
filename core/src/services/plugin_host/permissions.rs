/// Check if the given permission set includes the required permission.
/// "write" implicitly includes "read".
pub fn has_permission(permissions: &[String], required: &str) -> bool {
    permissions
        .iter()
        .any(|p| p == required || (p == "write" && required == "read"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_has_read_permission() {
        let perms = vec!["read".to_string()];
        assert!(has_permission(&perms, "read"));
        assert!(!has_permission(&perms, "write"));
    }

    #[test]
    fn test_write_implies_read() {
        let perms = vec!["write".to_string()];
        assert!(has_permission(&perms, "read"));
        assert!(has_permission(&perms, "write"));
    }
}
