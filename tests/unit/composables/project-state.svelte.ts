/**
 * Reactive stand-in for `projectStore.dirPath` in composable tests. A plain
 * object can't be tracked by `$effect`, so switching projects in a test would
 * never re-run the composable's project-dependent effects.
 */
export const projectState = $state({ dirPath: null as string | null });
