export type AiAgentProjectToken = {
  id: number;
  projectDir: string | null;
};

export type AiAgentLifecycleStatus =
  | { kind: 'idle'; projectDir: string | null; token: AiAgentProjectToken }
  | { kind: 'loading'; projectDir: string | null; token: AiAgentProjectToken }
  | { kind: 'ready'; projectDir: string | null; token: AiAgentProjectToken }
  | { kind: 'error'; projectDir: string | null; token: AiAgentProjectToken; message: string };

export type AiAgentLifecycleHooks = {
  teardownProject(ctx: AiAgentProjectToken): Promise<void>;
  clearVolatileContext(ctx: AiAgentProjectToken): void;
  loadProject(ctx: AiAgentProjectToken): Promise<void>;
  onLoadFailure?(ctx: AiAgentProjectToken, error: unknown): void;
};

export type Unlisten = () => void;

export type LiveStartOptions = {
  token: AiAgentProjectToken;
  sessionUuid: string;
  isCurrent(token: AiAgentProjectToken): boolean;
  spawn(): Promise<unknown>;
  listen(): Promise<Unlisten>;
  kill(sessionUuid: string): Promise<void>;
  register(unlisten: Unlisten): void;
};

export type ListenerAttachOptions = Omit<LiveStartOptions, 'spawn'>;

export type SendMutationGuardOptions = {
  token: AiAgentProjectToken;
  isCurrent(token: AiAgentProjectToken): boolean;
  persist(projectDir: string | null): Promise<void>;
  mutate(): void;
};

export type ApplyFileGuardOptions = {
  token: AiAgentProjectToken;
  sourceProjectDir: string | null | undefined;
  filePath: string;
  expectedText: string | null;
  proposedText: string;
  isCurrent(token: AiAgentProjectToken): boolean;
  compareAndWrite(
    expectedText: string | null,
    proposedText: string,
  ): Promise<'written' | 'conflict'>;
  markConflict(reason?: string): void;
  markAccepted(): void;
};

export type ApplyFileGuardResult = 'accepted' | 'conflict' | 'stale';

export type AiSessionPersistenceQueue = {
  enqueue(
    projectDir: string,
    sessionId: string,
    operation: () => Promise<void>,
  ): Promise<void>;
  closeAndDrain(): Promise<void>;
};

export class AiSessionPersistenceQueueClosedError extends Error {
  constructor() {
    super('AI session persistence queue is closed');
    this.name = 'AiSessionPersistenceQueueClosedError';
  }
}

export type AiAgentMountLease = Readonly<{
  id: number;
  predecessor: Promise<void>;
  isCurrent(): boolean;
  retire(retirement: Promise<void>): boolean;
}>;

type AiAgentMountLeaseRecord = {
  id: number;
  barrier: Promise<void>;
  settleBarrier(): void;
  retired: boolean;
};

let nextMountLeaseId = 0;
let latestMountLease: AiAgentMountLeaseRecord | null = null;

export function acquireAiAgentMountLease(): AiAgentMountLease {
  const predecessor = latestMountLease?.barrier ?? Promise.resolve();
  let settleBarrier!: () => void;
  const record: AiAgentMountLeaseRecord = {
    id: ++nextMountLeaseId,
    barrier: new Promise<void>((resolve) => { settleBarrier = resolve; }),
    settleBarrier: () => settleBarrier(),
    retired: false,
  };
  latestMountLease = record;

  return {
    id: record.id,
    predecessor,
    isCurrent: () => latestMountLease === record && !record.retired,
    retire(retirement) {
      if (record.retired) return false;
      record.retired = true;
      void retirement.then(record.settleBarrier, record.settleBarrier);
      return true;
    },
  };
}

export type AiAgentAttempt = Readonly<{
  turnId: string;
  generation: number;
  phase: 'reserved' | 'running' | 'cancelling';
}>;

export type AiAgentAttemptOwner = {
  claim(sessionId: string, turnId: string): AiAgentAttempt | null;
  current(sessionId: string): AiAgentAttempt | null;
  owns(sessionId: string, attempt: AiAgentAttempt): boolean;
  bindTurn(sessionId: string, attempt: AiAgentAttempt, turnId: string): AiAgentAttempt | null;
  markRunning(sessionId: string, attempt: AiAgentAttempt): AiAgentAttempt | null;
  markCancelling(sessionId: string, attempt: AiAgentAttempt): AiAgentAttempt | null;
  release(sessionId: string, attempt: AiAgentAttempt): boolean;
  clear(): void;
};

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAiSessionPersistenceQueue(): AiSessionPersistenceQueue {
  const tails = new Map<string, Promise<void>>();
  const accepted = new Set<Promise<void>>();
  let closed = false;

  return {
    enqueue(projectDir, sessionId, operation) {
      if (closed) return Promise.reject(new AiSessionPersistenceQueueClosedError());
      const key = `${projectDir}\0${sessionId}`;
      const previous = tails.get(key) ?? Promise.resolve();
      const current = previous.then(operation, operation);
      const tail = current.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      accepted.add(current);
      void current.then(
        () => accepted.delete(current),
        () => accepted.delete(current),
      );
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return current;
    },
    async closeAndDrain() {
      closed = true;
      const pending = [...accepted];
      await Promise.all(pending.map((operation) => operation.then(
        () => undefined,
        () => undefined,
      )));
    },
  };
}

export function createAiAgentAttemptOwner(): AiAgentAttemptOwner {
  const attempts = new Map<string, AiAgentAttempt>();
  let nextGeneration = 0;

  function owns(sessionId: string, attempt: AiAgentAttempt): boolean {
    return attempts.get(sessionId)?.generation === attempt.generation;
  }

  return {
    claim(sessionId, turnId) {
      if (attempts.has(sessionId)) return null;
      const attempt: AiAgentAttempt = {
        turnId,
        generation: ++nextGeneration,
        phase: 'reserved',
      };
      attempts.set(sessionId, attempt);
      return attempt;
    },
    current(sessionId) {
      return attempts.get(sessionId) ?? null;
    },
    owns,
    bindTurn(sessionId, attempt, turnId) {
      const current = attempts.get(sessionId);
      if (!current || current.generation !== attempt.generation || current.phase !== 'reserved') return null;
      const bound: AiAgentAttempt = { ...current, turnId };
      attempts.set(sessionId, bound);
      return bound;
    },
    markRunning(sessionId, attempt) {
      const current = attempts.get(sessionId);
      if (!current || current.generation !== attempt.generation || current.phase !== 'reserved') return null;
      const running: AiAgentAttempt = { ...current, phase: 'running' };
      attempts.set(sessionId, running);
      return running;
    },
    markCancelling(sessionId, attempt) {
      const current = attempts.get(sessionId);
      if (!current || current.generation !== attempt.generation) return null;
      const cancelling: AiAgentAttempt = { ...current, phase: 'cancelling' };
      attempts.set(sessionId, cancelling);
      return cancelling;
    },
    release(sessionId, attempt) {
      if (!owns(sessionId, attempt)) return false;
      attempts.delete(sessionId);
      return true;
    },
    clear() {
      attempts.clear();
    },
  };
}

function normalizeForScope(raw: string): string | null {
  const unified = raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  const drive = /^([A-Za-z]:)(?:\/|$)/.exec(unified);
  const rooted = unified.startsWith('/');
  const prefix = drive ? drive[1].toLowerCase() : rooted ? '/' : '';
  const body = drive ? unified.slice(drive[0].length) : rooted ? unified.replace(/^\/+/, '') : unified;
  const segments: string[] = [];

  for (const segment of body.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (drive) {
    const scoped = segments.length > 0 ? `${prefix}/${segments.join('/')}` : prefix;
    return scoped.toLowerCase();
  }
  if (rooted) return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
  return segments.join('/');
}

async function killQuietly(kill: (sessionUuid: string) => Promise<void>, sessionUuid: string): Promise<void> {
  try {
    await kill(sessionUuid);
  } catch (error) {
    console.warn('[ai-agent] stale runtime cleanup failed', error);
  }
}

export async function attachListenerIfCurrent(options: ListenerAttachOptions): Promise<boolean> {
  let unlisten: Unlisten;
  try {
    unlisten = await options.listen();
  } catch (error) {
    await killQuietly(options.kill, options.sessionUuid);
    throw error;
  }
  if (!options.isCurrent(options.token)) {
    try {
      unlisten();
    } catch (error) {
      console.warn('[ai-agent] stale listener cleanup failed', error);
    }
    await killQuietly(options.kill, options.sessionUuid);
    return false;
  }
  options.register(unlisten);
  return true;
}

export async function startLiveSessionIfCurrent(options: LiveStartOptions): Promise<string | null> {
  await options.spawn();
  if (!options.isCurrent(options.token)) {
    await killQuietly(options.kill, options.sessionUuid);
    return null;
  }
  const attached = await attachListenerIfCurrent(options);
  return attached ? options.sessionUuid : null;
}

export async function mutateAndPersistForToken(options: SendMutationGuardOptions): Promise<boolean> {
  if (!options.isCurrent(options.token)) return false;
  options.mutate();
  if (!options.isCurrent(options.token)) return false;
  await options.persist(options.token.projectDir);
  return options.isCurrent(options.token);
}

export async function applyFileIfCurrent(options: ApplyFileGuardOptions): Promise<ApplyFileGuardResult> {
  if (
    !options.isCurrent(options.token) ||
    options.sourceProjectDir !== options.token.projectDir ||
    !isProjectScopedPath(options.token.projectDir, options.filePath)
  ) {
    if (options.isCurrent(options.token)) options.markConflict();
    return options.isCurrent(options.token) ? 'conflict' : 'stale';
  }

  const writeResult = await options.compareAndWrite(options.expectedText, options.proposedText);
  if (!options.isCurrent(options.token)) return 'stale';

  if (writeResult === 'conflict') {
    options.markConflict('File changed since proposal was generated.');
    return 'conflict';
  }

  options.markAccepted();
  return 'accepted';
}

export class AiAgentProjectLifecycle {
  #hooks: AiAgentLifecycleHooks;
  #tokenId = 0;
  #currentProjectDir: string | null = null;
  #loadedProjectDir: string | null = null;
  #hasLoadedProject = false;
  #queue: Promise<void> = Promise.resolve();
  #status: AiAgentLifecycleStatus;

  constructor(hooks: AiAgentLifecycleHooks) {
    this.#hooks = hooks;
    const token = this.#nextToken(null);
    this.#status = { kind: 'idle', projectDir: null, token };
  }

  get status(): AiAgentLifecycleStatus {
    return this.#status;
  }

  get currentProjectDir(): string | null {
    return this.#currentProjectDir;
  }

  get loadedProjectDir(): string | null {
    return this.#loadedProjectDir;
  }

  capture(): AiAgentProjectToken {
    return this.#status.token;
  }

  isCurrent(token: AiAgentProjectToken | number): boolean {
    const id = typeof token === 'number' ? token : token.id;
    return id === this.#status.token.id;
  }

  invalidate(): AiAgentProjectToken {
    const token = this.#nextToken(this.#currentProjectDir);
    this.#status = { kind: 'loading', projectDir: this.#currentProjectDir, token };
    return token;
  }

  takeLoadedProjectForTeardown(): string | null {
    const projectDir = this.#loadedProjectDir;
    this.#loadedProjectDir = null;
    this.#hasLoadedProject = false;
    return projectDir;
  }

  switchTo(projectDir: string | null, reload = false): Promise<void> {
    if (
      !reload &&
      projectDir === this.#currentProjectDir &&
      projectDir === this.#loadedProjectDir &&
      this.#hasLoadedProject &&
      this.#status.kind === 'ready'
    ) {
      return this.#queue;
    }

    const token = this.#nextToken(projectDir);
    this.#currentProjectDir = projectDir;
    this.#status = { kind: 'loading', projectDir, token };
    const runSwitch = () => this.#switchNow(projectDir, token);
    this.#queue = this.#queue.then(runSwitch, runSwitch);
    return this.#queue;
  }

  drain(): Promise<void> {
    return this.#queue;
  }

  #nextToken(projectDir: string | null): AiAgentProjectToken {
    return { id: ++this.#tokenId, projectDir };
  }

  async #switchNow(projectDir: string | null, token: AiAgentProjectToken): Promise<void> {
    const previousProjectDir = this.#loadedProjectDir;
    const hadLoadedProject = this.#hasLoadedProject;

    if (hadLoadedProject) {
      await this.#hooks.teardownProject({ ...token, projectDir: previousProjectDir });
      if (this.#loadedProjectDir === previousProjectDir) {
        this.#loadedProjectDir = null;
        this.#hasLoadedProject = false;
      }
    }

    if (!this.isCurrent(token)) return;

    this.#hooks.clearVolatileContext(token);

    if (!this.isCurrent(token)) return;

    try {
      await this.#hooks.loadProject(token);
      if (!this.isCurrent(token)) return;
      this.#loadedProjectDir = projectDir;
      this.#hasLoadedProject = true;
      this.#status = { kind: 'ready', projectDir, token };
    } catch (error) {
      if (!this.isCurrent(token)) return;
      this.#loadedProjectDir = null;
      this.#hasLoadedProject = false;
      this.#status = { kind: 'error', projectDir, token, message: messageFrom(error) };
      this.#hooks.onLoadFailure?.(token, error);
    }
  }
}

export function isProjectScopedPath(projectDir: string | null, path: string): boolean {
  if (!projectDir) return false;
  const normalizedProject = normalizeForScope(projectDir);
  const normalizedPath = normalizeForScope(path);
  if (!normalizedProject || !normalizedPath) return false;
  return normalizedPath === normalizedProject || normalizedPath.startsWith(`${normalizedProject}/`);
}
