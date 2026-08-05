import { pathJoin } from '$lib/utils/path';

const STORAGE_PREFIX = 'novelist:project-workspace:v1:';
const MAX_EXPANDED_PATHS = 512;

export interface ProjectWorkspaceState {
  version: 1;
  expandedPaths: string[];
  lastOpenPath: string | null;
}

function emptyState(): ProjectWorkspaceState {
  return { version: 1, expandedPaths: [], lastOpenPath: null };
}

function storageKey(projectDir: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(normalizeAbsolutePath(projectDir))}`;
}

function normalizeAbsolutePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (normalized === '/') return normalized;
  return normalized.replace(/\/+$/, '');
}

function normalizeRelativePath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('\0')) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function isWindowsStyle(...paths: string[]): boolean {
  return paths.some(path => /^[A-Za-z]:/.test(path) || path.includes('\\'));
}

export function toProjectRelativePath(projectDir: string, path: string): string | null {
  const normalizedProject = normalizeAbsolutePath(projectDir);
  const normalizedPath = normalizeAbsolutePath(path);
  const windowsStyle = isWindowsStyle(projectDir, path);
  const comparableProject = windowsStyle ? normalizedProject.toLowerCase() : normalizedProject;
  const comparablePath = windowsStyle ? normalizedPath.toLowerCase() : normalizedPath;
  if (!comparablePath.startsWith(`${comparableProject}/`)) return null;
  return normalizeRelativePath(normalizedPath.slice(normalizedProject.length + 1));
}

export function resolveProjectWorkspacePath(projectDir: string, relativePath: string): string | null {
  const normalized = normalizeRelativePath(relativePath);
  return normalized
    ? normalized.split('/').reduce((path, segment) => pathJoin(path, segment), projectDir)
    : null;
}

export function loadProjectWorkspaceState(projectDir: string): ProjectWorkspaceState {
  try {
    const raw = localStorage.getItem(storageKey(projectDir));
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<ProjectWorkspaceState>;
    const expandedPaths = Array.isArray(parsed.expandedPaths)
      ? parsed.expandedPaths
          .filter((path): path is string => typeof path === 'string')
          .map(normalizeRelativePath)
          .filter((path): path is string => path !== null)
      : [];
    const lastOpenPath = typeof parsed.lastOpenPath === 'string'
      ? normalizeRelativePath(parsed.lastOpenPath)
      : null;
    return {
      version: 1,
      expandedPaths: [...new Set(expandedPaths)].slice(0, MAX_EXPANDED_PATHS),
      lastOpenPath,
    };
  } catch {
    return emptyState();
  }
}

export function saveProjectWorkspaceState(
  projectDir: string,
  state: ProjectWorkspaceState,
): ProjectWorkspaceState {
  const normalized: ProjectWorkspaceState = {
    version: 1,
    expandedPaths: [...new Set(
      state.expandedPaths
        .map(normalizeRelativePath)
        .filter((path): path is string => path !== null),
    )].slice(0, MAX_EXPANDED_PATHS),
    lastOpenPath: state.lastOpenPath ? normalizeRelativePath(state.lastOpenPath) : null,
  };
  try {
    localStorage.setItem(storageKey(projectDir), JSON.stringify(normalized));
  } catch {
    // Workspace restoration is best effort; storage denial must not block editing.
  }
  return normalized;
}

export function retargetProjectWorkspaceState(
  projectDir: string,
  state: ProjectWorkspaceState,
  oldPath: string,
  newPath: string,
): ProjectWorkspaceState {
  const oldRelative = toProjectRelativePath(projectDir, oldPath);
  const newRelative = toProjectRelativePath(projectDir, newPath);
  if (!oldRelative || !newRelative) return state;
  const retarget = (path: string): string => path === oldRelative
    ? newRelative
    : path.startsWith(`${oldRelative}/`)
      ? `${newRelative}${path.slice(oldRelative.length)}`
      : path;
  return saveProjectWorkspaceState(projectDir, {
    version: 1,
    expandedPaths: state.expandedPaths.map(retarget),
    lastOpenPath: state.lastOpenPath ? retarget(state.lastOpenPath) : null,
  });
}

export function removeProjectWorkspacePath(
  projectDir: string,
  state: ProjectWorkspaceState,
  removedPath: string,
): ProjectWorkspaceState {
  const removedRelative = toProjectRelativePath(projectDir, removedPath);
  if (!removedRelative) return state;
  const contains = (path: string): boolean => path === removedRelative
    || path.startsWith(`${removedRelative}/`);
  return saveProjectWorkspaceState(projectDir, {
    version: 1,
    expandedPaths: state.expandedPaths.filter(path => !contains(path)),
    lastOpenPath: state.lastOpenPath && contains(state.lastOpenPath)
      ? null
      : state.lastOpenPath,
  });
}
