export type ProjectWatcherResult =
  | { status: 'ok'; data: unknown }
  | { status: 'error'; error: unknown };

interface ProjectWatcherHooks {
  stop(): Promise<ProjectWatcherResult>;
  start(projectDir: string): Promise<ProjectWatcherResult>;
}

export class ProjectWatcherOwner {
  #hooks: ProjectWatcherHooks;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(hooks: ProjectWatcherHooks) {
    this.#hooks = hooks;
  }

  stop(isCurrent: () => boolean): Promise<ProjectWatcherResult | null> {
    return this.#enqueue(isCurrent, () => this.#hooks.stop());
  }

  start(
    projectDir: string,
    isCurrent: () => boolean,
  ): Promise<ProjectWatcherResult | null> {
    return this.#enqueue(isCurrent, () => this.#hooks.start(projectDir));
  }

  #enqueue(
    isCurrent: () => boolean,
    operation: () => Promise<ProjectWatcherResult>,
  ): Promise<ProjectWatcherResult | null> {
    const run = async () => (isCurrent() ? operation() : null);
    const result = this.#queue.then(run, run);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
