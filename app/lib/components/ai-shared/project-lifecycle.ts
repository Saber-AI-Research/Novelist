export type AiProjectToken = {
  id: number;
  projectDir: string | null;
};

export type AiProjectLifecycleStatus =
  | { kind: 'idle'; projectDir: string | null; token: AiProjectToken }
  | { kind: 'loading'; projectDir: string | null; token: AiProjectToken }
  | { kind: 'ready'; projectDir: string | null; token: AiProjectToken }
  | { kind: 'error'; projectDir: string | null; token: AiProjectToken; message: string };

export type AiProjectLifecycleHooks = {
  teardownProject(ctx: AiProjectToken): Promise<void>;
  clearVolatileContext(ctx: AiProjectToken): void;
  loadProject(ctx: AiProjectToken): Promise<void>;
  onLoadFailure?(ctx: AiProjectToken, error: unknown): void;
};

/**
 * Serializes an AI panel's project switches: the previously loaded project
 * is torn down before the next one loads, and every switch mints a new
 * token so async work started for an older project can detect it is stale.
 */
export class AiProjectLifecycle {
  #hooks: AiProjectLifecycleHooks;
  #tokenId = 0;
  #currentProjectDir: string | null = null;
  #loadedProjectDir: string | null = null;
  #hasLoadedProject = false;
  #queue: Promise<void> = Promise.resolve();
  #status: AiProjectLifecycleStatus;

  constructor(hooks: AiProjectLifecycleHooks) {
    this.#hooks = hooks;
    const token = this.#nextToken(null);
    this.#status = { kind: 'idle', projectDir: null, token };
  }

  get status(): AiProjectLifecycleStatus {
    return this.#status;
  }

  get loadedProjectDir(): string | null {
    return this.#loadedProjectDir;
  }

  isCurrent(token: AiProjectToken): boolean {
    return token.id === this.#status.token.id;
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

  #nextToken(projectDir: string | null): AiProjectToken {
    return { id: ++this.#tokenId, projectDir };
  }

  async #switchNow(projectDir: string | null, token: AiProjectToken): Promise<void> {
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
      const message = error instanceof Error ? error.message : String(error);
      this.#status = { kind: 'error', projectDir, token, message };
      this.#hooks.onLoadFailure?.(token, error);
    }
  }
}
