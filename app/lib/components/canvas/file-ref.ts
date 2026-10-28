/**
 * `.canvas` file-card references. A note inside the open project is stored
 * relative to the project root with `/` separators (the JSON Canvas
 * convention), so the same canvas keeps working when the project moves: an
 * iOS container relocation, another device's library root, a synced or
 * archived copy. In memory the card holds the resolved path that file
 * commands need. Anything outside the project stays exactly as written: an
 * explicit external reference that only resolves where that path exists.
 */

/** POSIX/Windows absolute paths, UNC paths and URIs (`file:`, `content:`). */
const ABSOLUTE_REF = /^(?:[A-Za-z]:[\\/]|[\\/]|[A-Za-z][A-Za-z0-9+.-]+:)/;

export function isAbsoluteFileRef(ref: string): boolean {
  return ABSOLUTE_REF.test(ref);
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** In-memory path → stored reference: project-relative when inside `projectRoot`. */
export function toCanvasFileRef(path: string, projectRoot: string | null): string {
  if (!projectRoot || !isAbsoluteFileRef(path)) return path;
  const root = normalize(projectRoot);
  const target = normalize(path);
  return root && target.startsWith(`${root}/`) ? target.slice(root.length + 1) : path;
}

/** True when a relative ref climbs out of the root once `.`/`..` segments apply. */
function escapesRoot(ref: string): boolean {
  let depth = 0;
  for (const part of ref.split(/[\\/]/)) {
    if (part === '..') {
      if (--depth < 0) return true;
    } else if (part && part !== '.') {
      depth++;
    }
  }
  return false;
}

/**
 * Stored reference → path for file commands, resolved against the current
 * project root. A ref that would climb out of the root stays verbatim (and
 * unreadable); it is never joined into a path outside the project.
 */
export function resolveCanvasFileRef(ref: string, projectRoot: string | null): string {
  if (!projectRoot || !ref || isAbsoluteFileRef(ref) || escapesRoot(ref)) return ref;
  const relative = ref.replace(/^\.\//, '');
  // Join with the root's own separator so a resolved note matches the path
  // the sidebar and tabs use for the same file.
  if (projectRoot.includes('\\') && !projectRoot.includes('/')) {
    return `${projectRoot.replace(/\\+$/, '')}\\${relative.replace(/\//g, '\\')}`;
  }
  return `${projectRoot.replace(/\/+$/, '')}/${relative}`;
}

/**
 * Whether a file card may read (preview or open) `path`. Canvases arrive via
 * cloud sync, so on mobile only notes inside the open project are read: an
 * external path, a URI or a traversal could otherwise reach the app's own
 * data. Desktop keeps reading external links as before. Unresolved refs
 * (no project open, or escaping the root) are never read anywhere.
 */
export function canReadCanvasFile(path: string, projectRoot: string | null, mobile: boolean): boolean {
  if (!isAbsoluteFileRef(path)) return false;
  if (!mobile) return true;
  if (!projectRoot) return false;
  const root = normalize(projectRoot);
  const target = normalize(path);
  if (!root || !target.startsWith(`${root}/`)) return false;
  return !target.slice(root.length + 1).split('/').includes('..');
}
