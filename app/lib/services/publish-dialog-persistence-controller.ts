import {
  publishFormPersistence,
  type PublishFormDraft,
  type PublishFormDraftIdentity,
  type PublishFormPersistence,
} from '$lib/services/publish-form-persistence';
import { pathStartsWithChild } from '$lib/utils/path';

export type PublishDialogFormFields = PublishFormDraft;

export interface PublishDialogControllerHooks {
  identity: PublishFormDraftIdentity;
  readFields(): PublishDialogFormFields;
  applyFields(fields: PublishDialogFormFields): void;
  onCorruptDraft(): void;
  onRestoreComplete?(): void;
  persistence?: PublishFormPersistence;
}

export interface PublishDialogController {
  readonly identity: PublishFormDraftIdentity;
  readonly restoreReady: boolean;
  readonly hasUserInput: boolean;
  readonly isRetired: boolean;
  handleUserInput(): void;
  handleFieldChange(): void;
  handleRenameFlush(oldPath: string): Promise<void>;
  handleProjectSwitch(currentProjectDir: string | null): Promise<void>;
  handleClose(): Promise<void>;
  handleBeforePublish(): Promise<void>;
  handleAfterPublishSuccess(): Promise<void>;
  handleDestroy(): Promise<void>;
  loadInitialDraft(): Promise<void>;
}

export function createPublishDialogPersistenceController(
  hooks: PublishDialogControllerHooks,
): PublishDialogController {
  const persistence = hooks.persistence ?? publishFormPersistence;
  const identity = hooks.identity;
  let restoreReady = false;
  let hasUserInput = false;
  let retired = false;

  function scheduleWrite(): void {
    if (retired) return;
    if (!restoreReady && !hasUserInput) return;
    persistence.queueWrite(identity, hooks.readFields());
  }

  async function flushOwnedIdentity(): Promise<void> {
    if (retired) return;
    if (restoreReady || hasUserInput) {
      persistence.queueWrite(identity, hooks.readFields());
    }
    await persistence.flush(identity);
  }

  async function flushAndRetireOnSuccess(): Promise<void> {
    if (retired) return;
    await flushOwnedIdentity();
    retired = true;
  }

  return {
    get identity() {
      return identity;
    },
    get restoreReady() {
      return restoreReady;
    },
    get hasUserInput() {
      return hasUserInput;
    },
    get isRetired() {
      return retired;
    },

    handleUserInput(): void {
      if (retired) return;
      hasUserInput = true;
    },

    handleFieldChange(): void {
      scheduleWrite();
    },

    async loadInitialDraft(): Promise<void> {
      try {
        const loaded = await persistence.loadDrafts(identity.projectDir, identity.filePath);
        if (retired) return;
        if (loaded.readError || loaded.invalidChannelIds.includes(identity.channelId)) {
          hooks.onCorruptDraft();
        } else if (!hasUserInput) {
          const persisted = loaded.forms.get(identity.channelId);
          if (persisted) hooks.applyFields(persisted);
        }
      } finally {
        if (!retired) {
          restoreReady = true;
          hooks.onRestoreComplete?.();
        }
      }
    },

    async handleRenameFlush(oldPath: string): Promise<void> {
      if (retired) return;
      if (!identity.projectDir || !identity.filePath) return;
      if (
        identity.filePath !== oldPath &&
        !pathStartsWithChild(identity.filePath, oldPath)
      ) {
        return;
      }
      if (restoreReady || hasUserInput) {
        persistence.queueWrite(identity, hooks.readFields());
      }
      await persistence.flushForRename(identity.projectDir, oldPath);
      retired = true;
    },

    async handleProjectSwitch(currentProjectDir: string | null): Promise<void> {
      if (retired) return;
      if (currentProjectDir === identity.projectDir) return;
      await flushAndRetireOnSuccess();
    },

    async handleClose(): Promise<void> {
      await flushAndRetireOnSuccess();
    },

    async handleBeforePublish(): Promise<void> {
      await flushOwnedIdentity();
    },

    async handleAfterPublishSuccess(): Promise<void> {
      await flushOwnedIdentity();
    },

    async handleDestroy(): Promise<void> {
      if (retired) return;
      await flushAndRetireOnSuccess();
    },
  };
}
