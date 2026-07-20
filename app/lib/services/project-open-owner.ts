export interface ProjectOpenToken {
  id: number;
  projectDir: string;
}

export class ProjectOpenOwner {
  #nextId = 0;
  #current: ProjectOpenToken | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #sealedTokenId: number | null = null;
  #deferred: ProjectOpenToken | null = null;
  #cancelAfterSeal = false;

  begin(
    projectDir: string,
    committedProjectDir: string | null,
    committedGeneration = 0,
  ): ProjectOpenToken | null {
    if (this.#current?.projectDir === projectDir) return null;
    if (!this.#current && !this.#deferred && projectDir === committedProjectDir) return null;

    this.#nextId = Math.max(this.#nextId, committedGeneration) + 1;
    const token = { id: this.#nextId, projectDir };
    if (this.#sealedTokenId === this.#current?.id) this.#deferred = token;
    else this.#current = token;
    return token;
  }

  isCurrent(token: ProjectOpenToken): boolean {
    return this.#current?.id === token.id;
  }

  cancel(): Promise<void> {
    this.#nextId += 1;
    this.#deferred = null;
    if (this.#sealedTokenId === this.#current?.id) this.#cancelAfterSeal = true;
    else this.#current = null;
    return this.#queue.then(() => undefined, () => undefined);
  }

  seal(token: ProjectOpenToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.#sealedTokenId = token.id;
    return true;
  }

  run<T>(token: ProjectOpenToken, operation: () => Promise<T>): Promise<T | undefined> {
    const execute = async () => {
      if (this.#deferred?.id === token.id) {
        this.#current = token;
        this.#deferred = null;
      }
      return this.isCurrent(token) ? operation() : undefined;
    };
    const result = this.#queue.then(execute, execute);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  settle(token: ProjectOpenToken): void {
    if (!this.isCurrent(token)) return;
    this.#current = null;
    if (this.#sealedTokenId === token.id) this.#sealedTokenId = null;
    if (this.#cancelAfterSeal) this.#cancelAfterSeal = false;
  }
}
