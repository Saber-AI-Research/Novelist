export interface ScreenshotDimensions {
  width: number;
  height: number;
}

export interface ScreenshotViewport {
  innerWidth: number;
  innerHeight: number;
}

export interface ScreenshotCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContainedScreenshotCrop {
  scale: number;
  contentTop: number;
  crop: ScreenshotCrop;
}

export function computeContainedScreenshotCrop(
  image: ScreenshotDimensions,
  viewport: ScreenshotViewport,
  crop: ScreenshotCrop,
): ContainedScreenshotCrop;

export interface NativeEditorSnapshot {
  content: string;
  storeContent: string;
  dirty: boolean;
  composing: boolean;
  filePath: string;
}

export interface ExpectedDirtyConflictState {
  editorContent: string;
  storeContent: string;
  filePath: string;
}

export function dirtyConflictStatePreserved(
  dirtySnapshot: NativeEditorSnapshot,
  unresolvedSnapshot: NativeEditorSnapshot,
  expected: ExpectedDirtyConflictState,
): boolean;

export const RUN_OWNED_PATH_KEYS: readonly [
  'socket',
  'runRoot',
  'project',
  'home',
  'temp',
  'config',
  'clipboardSnapshot',
  'pasteboardHelper',
  'supervisor',
  'bundle',
  'png',
  'screenshot',
  'tauriLog',
  'owner',
  'initialFile',
  'playwrightOutput',
];

export type RunOwnedPathKey = (typeof RUN_OWNED_PATH_KEYS)[number];
export type RunOwnedPathInventory = Record<RunOwnedPathKey, string>;

export function buildRunOwnedPathInventory(paths: Readonly<Record<string, string>>): RunOwnedPathInventory;

export function runOwnedPathResidue<const Key extends string>(
  paths: Readonly<Record<Key, string>>,
  pathExists: (ownedPath: string) => boolean,
): Record<Key, boolean>;

export const NATIVE_FIXTURE_TEARDOWN_TIMEOUT_MS: number;
export const PLAYWRIGHT_CHILD_REPORT_EXIT_BUFFER_MS: number;
export const PLAYWRIGHT_CHILD_TIMEOUT_MS: number;
export const PLAYWRIGHT_CHILD_TERM_GRACE_MS: number;
export const PLAYWRIGHT_CHILD_KILL_GRACE_MS: number;

export interface PlaywrightChildWatchdogOptions {
  timeoutMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
  signalProcessGroup?: (groupPid: number, signal: NodeJS.Signals | 0) => boolean;
}

export interface PlaywrightChildResult {
  exitCode: number;
  reason: string;
  timedOut: boolean;
}

export function waitForPlaywrightChild(
  child: unknown,
  options?: PlaywrightChildWatchdogOptions,
): Promise<PlaywrightChildResult>;

export function awaitInteractiveEvidence(
  evidencePromise: Promise<void> | undefined,
  cleanupErrors: string[],
): Promise<void>;

export interface PreparedNativeArtifact {
  runId: string;
  startedAtMs: number;
  sha256: string;
  bytes: Uint8Array;
}

export interface PublishedNativeArtifact {
  fresh: boolean;
  runId: string;
  startedAtMs: number;
  sha256: string;
  bytes: number;
  published: boolean;
}

export function publishPreparedArtifactTransaction(
  prepared: PreparedNativeArtifact,
  sharedPath: string,
  publishEvidence: (artifact: PublishedNativeArtifact) => Promise<void>,
): Promise<PublishedNativeArtifact>;
