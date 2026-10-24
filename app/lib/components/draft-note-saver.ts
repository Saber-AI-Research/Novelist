/** The draft being edited: which project's `.novelist` folder and which file it belongs to. */
export interface DraftTarget {
  projectDir: string;
  filePath: string;
}

export interface DraftNoteSaverDeps {
  write(target: DraftTarget, content: string): Promise<void>;
  /** Current editor text, or null when no editor is mounted. */
  getContent(): string | null;
  onDirtyChange(dirty: boolean): void;
}

/**
 * Saves the draft note to the project and file it was loaded for. The target
 * is captured on load, never read from the project store at save time, so a
 * save that runs during a project switch (unmount, debounce timer, flush)
 * cannot write the old file's draft into the new project.
 */
export class DraftNoteSaver {
  #deps: DraftNoteSaverDeps;
  #target: DraftTarget | null = null;
  #dirty = false;
  #pending: Promise<void> | null = null;
  #queued: { target: DraftTarget; content: string } | null = null;

  constructor(deps: DraftNoteSaverDeps) {
    this.#deps = deps;
  }

  get target(): DraftTarget | null {
    return this.#target;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  /** Point at a freshly loaded draft (save the previous one first). */
  setTarget(target: DraftTarget | null): void {
    this.#target = target;
    this.#setDirty(false);
  }

  markDirty(): void {
    this.#setDirty(true);
  }

  /** Save the current text. Text and target are captured now, before any wait. */
  save(): Promise<void> {
    const target = this.#target;
    const content = this.#deps.getContent();
    if (!target || content === null) return this.#pending ?? Promise.resolve();
    if (this.#pending) {
      this.#queued = { target, content };
      const queuedBehind = this.#pending;
      return queuedBehind.then(() => this.#writeQueued(), () => this.#writeQueued());
    }
    return this.#write(target, content);
  }

  /** Save if dirty and wait for every write in flight. */
  async flush(): Promise<void> {
    if (this.#dirty) await this.save();
    while (this.#pending) await this.#pending.catch(() => {});
  }

  #writeQueued(): Promise<void> {
    const queued = this.#queued;
    if (!queued) return this.#pending ?? Promise.resolve();
    this.#queued = null;
    return this.#write(queued.target, queued.content);
  }

  #write(target: DraftTarget, content: string): Promise<void> {
    const write = this.#deps
      .write(target, content)
      .then(() => {
        if (this.#target === target && this.#deps.getContent() === content) this.#setDirty(false);
      })
      .catch((error) => {
        if (this.#target === target) this.#setDirty(true);
        throw error;
      })
      .finally(() => {
        if (this.#pending === write) this.#pending = null;
      });
    this.#pending = write;
    return write;
  }

  #setDirty(dirty: boolean): void {
    this.#dirty = dirty;
    this.#deps.onDirtyChange(dirty);
  }
}
