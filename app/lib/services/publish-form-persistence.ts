import { commands, type FormDraft } from '$lib/ipc/commands';
import { pathStartsWithChild } from '$lib/utils/path';

export interface PublishFormDraft {
  title: string;
  tags: string[];
  excerpt?: string;
  slug?: string;
  status?: string;
  destination?: string;
}

export interface PublishFormDraftIdentity {
  projectDir: string;
  filePath: string;
  channelId: string;
}

export interface PublishFormDraftLoadResult {
  forms: Map<string, PublishFormDraft>;
  invalidChannelIds: string[];
  readError: string | null;
}

const DEFAULT_DEBOUNCE_MS = 400;
const IDENTITY_SEPARATOR = '\0';

function identityKey(id: PublishFormDraftIdentity): string {
  return (
    id.projectDir + IDENTITY_SEPARATOR + id.filePath + IDENTITY_SEPARATOR + id.channelId
  );
}

function decodeIdentityKey(key: string): PublishFormDraftIdentity {
  const parts = key.split(IDENTITY_SEPARATOR);
  return { projectDir: parts[0], filePath: parts[1], channelId: parts[2] };
}

function toWireForm(form: PublishFormDraft): FormDraft {
  const wire: FormDraft = {
    title: form.title,
    tags: [...form.tags],
  };
  if (form.excerpt !== undefined) wire.excerpt = form.excerpt;
  if (form.slug !== undefined) wire.slug = form.slug;
  if (form.status !== undefined) wire.status = form.status;
  if (form.destination !== undefined) wire.destination = form.destination;
  return wire;
}

function fromWireForm(wire: FormDraft): PublishFormDraft {
  return {
    title: wire.title ?? '',
    tags: Array.isArray(wire.tags) ? [...wire.tags] : [],
    excerpt: wire.excerpt ?? undefined,
    slug: wire.slug ?? undefined,
    status: wire.status ?? undefined,
    destination: wire.destination ?? undefined,
  };
}

interface IdentityChain {
  latest: PublishFormDraft | null;
  timer: ReturnType<typeof setTimeout> | null;
  processing: Promise<void> | null;
  deferredError: Error | null;
}

export class PublishFormPersistence {
  private readonly debounceMs: number;
  private readonly chains = new Map<string, IdentityChain>();

  constructor(debounceMs = DEFAULT_DEBOUNCE_MS) {
    this.debounceMs = debounceMs;
  }

  async loadDrafts(projectDir: string, filePath: string): Promise<PublishFormDraftLoadResult> {
    const r = await commands.readPublishFormDrafts(projectDir, filePath);
    if (r.status !== 'ok') {
      return { forms: new Map(), invalidChannelIds: [], readError: String(r.error ?? 'read error') };
    }
    const forms = new Map<string, PublishFormDraft>();
    const wireForms = r.data.forms ?? {};
    for (const [channelId, wire] of Object.entries(wireForms)) {
      forms.set(channelId, fromWireForm(wire as FormDraft));
    }
    return {
      forms,
      invalidChannelIds: [...(r.data.invalid_channel_ids ?? [])],
      readError: null,
    };
  }

  queueWrite(id: PublishFormDraftIdentity, form: PublishFormDraft): void {
    const key = identityKey(id);
    const chain = this.chainFor(key);
    chain.latest = cloneForm(form);
    if (chain.timer) clearTimeout(chain.timer);
    chain.timer = setTimeout(() => {
      chain.timer = null;
      this.ensureProcessor(key, id);
    }, this.debounceMs);
  }

  cancel(id: PublishFormDraftIdentity): void {
    const key = identityKey(id);
    const chain = this.chains.get(key);
    if (!chain) return;
    if (chain.timer) clearTimeout(chain.timer);
    chain.timer = null;
    chain.latest = null;
    chain.deferredError = null;
  }

  async flush(id: PublishFormDraftIdentity): Promise<void> {
    const key = identityKey(id);
    const chain = this.chains.get(key);
    if (!chain) return;
    if (chain.timer) {
      clearTimeout(chain.timer);
      chain.timer = null;
    }
    if (chain.latest !== null || chain.processing) {
      this.ensureProcessor(key, id);
      if (chain.processing) await chain.processing;
    }
    if (chain.deferredError) {
      const err = chain.deferredError;
      chain.deferredError = null;
      throw err;
    }
  }

  async flushForRename(projectDir: string, oldPath: string): Promise<void> {
    const targets = this.collectIdentitiesForPath(projectDir, oldPath);
    const results = await Promise.allSettled(targets.map((id) => this.flush(id)));
    const first = results.find((r) => r.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    if (first) throw first.reason;
  }

  async flushAll(): Promise<void> {
    const keys = [...this.chains.keys()];
    const results = await Promise.allSettled(
      keys.map((key) => this.flush(decodeIdentityKey(key))),
    );
    const first = results.find((r) => r.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    if (first) throw first.reason;
  }

  private chainFor(key: string): IdentityChain {
    let chain = this.chains.get(key);
    if (!chain) {
      chain = { latest: null, timer: null, processing: null, deferredError: null };
      this.chains.set(key, chain);
    }
    return chain;
  }

  private collectIdentitiesForPath(projectDir: string, oldPath: string): PublishFormDraftIdentity[] {
    const matches: PublishFormDraftIdentity[] = [];
    for (const key of this.chains.keys()) {
      const id = decodeIdentityKey(key);
      if (id.projectDir !== projectDir) continue;
      if (id.filePath === oldPath || pathStartsWithChild(id.filePath, oldPath)) {
        matches.push(id);
      }
    }
    return matches;
  }

  private ensureProcessor(key: string, id: PublishFormDraftIdentity): void {
    const chain = this.chainFor(key);
    if (chain.processing) return;
    chain.processing = this.runProcessor(key, id).finally(() => {
      const c = this.chains.get(key);
      if (c) c.processing = null;
    });
  }

  private async runProcessor(key: string, id: PublishFormDraftIdentity): Promise<void> {
    while (true) {
      const chain = this.chains.get(key);
      if (!chain) return;
      const nextForm = chain.latest;
      if (nextForm === null) return;
      chain.latest = null;
      try {
        const r = await commands.writePublishFormDraft(
          id.projectDir,
          id.filePath,
          id.channelId,
          toWireForm(nextForm),
        );
        if (r.status !== 'ok') {
          throw new Error(String(r.error ?? 'write error'));
        }
        const successChain = this.chains.get(key);
        if (successChain) successChain.deferredError = null;
      } catch (err) {
        const c = this.chains.get(key);
        if (c) c.deferredError = err instanceof Error ? err : new Error(String(err));
        return;
      }
    }
  }
}

function cloneForm(form: PublishFormDraft): PublishFormDraft {
  return {
    title: form.title,
    tags: [...form.tags],
    excerpt: form.excerpt,
    slug: form.slug,
    status: form.status,
    destination: form.destination,
  };
}

export function createPublishFormPersistence(debounceMs?: number): PublishFormPersistence {
  return new PublishFormPersistence(debounceMs);
}

export const publishFormPersistence = new PublishFormPersistence();

export function __resetPublishFormPersistenceForTests(): void {
  const state = publishFormPersistence as unknown as {
    chains: Map<string, IdentityChain>;
  };
  for (const chain of state.chains.values()) {
    if (chain.timer) clearTimeout(chain.timer);
  }
  state.chains.clear();
}
