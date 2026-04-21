/**
 * Prompt preset library for AI Talk — saved, named prompt templates
 * users can apply per session. Inspired by YOLO's preset prompts.
 *
 * Built-in presets ship with the app; user presets live in localStorage
 * and support full CRUD. Built-ins can be soft-hidden (restored later)
 * but not deleted.
 *
 * Each preset carries its own systemPrompt (always) and optional
 * temperature / model overrides that take precedence over the global
 * AI Talk settings when applied to a session.
 */

export type PromptPreset = {
  id: string;
  name: string;
  systemPrompt: string;
  icon?: string;
  /** Optional overrides that take precedence over global settings. */
  temperature?: number;
  model?: string;
  /** True for ship-with-app presets; can be hidden but not deleted. */
  builtin: boolean;
};

const USER_PRESETS_KEY = 'novelist:ai-talk:prompt-presets:v1';
const HIDDEN_BUILTINS_KEY = 'novelist:ai-talk:hidden-builtin-presets:v1';

export const BUILTIN_PRESETS: PromptPreset[] = [
  {
    id: 'builtin:default',
    name: 'Default',
    icon: '💬',
    systemPrompt: 'You are a helpful writing assistant for novelists.',
    builtin: true,
  },
  {
    id: 'builtin:novelist-zh',
    name: '小说助手',
    icon: '✍️',
    systemPrompt:
      '你是一位中文小说写作助手。用户正在创作小说，你需要在情节、人物、对白、节奏、世界观等方面提供具体、可落地的建议。\n\n回复原则：\n- 中文回复，保持作者语气\n- 给具体改写示例，不要只给抽象评论\n- 尊重作者既有设定，提出改动先解释理由\n- 不自我审查，陪作者探索黑暗、复杂的题材',
    builtin: true,
  },
  {
    id: 'builtin:editor',
    name: 'Editor',
    icon: '📝',
    systemPrompt:
      'You are a rigorous line editor. Given prose, suggest edits for clarity, rhythm, word choice, and continuity. Return a numbered list of concrete changes with the original→suggested text shown side by side. Do not rewrite wholesale.',
    temperature: 0.3,
    builtin: true,
  },
  {
    id: 'builtin:translator',
    name: 'Translator',
    icon: '🌐',
    systemPrompt:
      'You are a literary translator. Translate faithfully, preserving tone, register, and rhythm. If the target language is ambiguous, infer from the most recent user message. Return ONLY the translation.',
    temperature: 0.2,
    builtin: true,
  },
  {
    id: 'builtin:summarizer',
    name: 'Summarizer',
    icon: '📋',
    systemPrompt:
      'Summarize the given material in crisp, plain prose. Preserve names, numbers, and causality; drop adjectives, qualifiers, and repetition. 3 paragraphs max unless asked otherwise.',
    temperature: 0.2,
    builtin: true,
  },
  {
    id: 'builtin:brainstorm',
    name: 'Brainstorm',
    icon: '💡',
    systemPrompt:
      'You are a fast brainstorming partner. For any prompt, return 8–12 distinct angles, one line each, no preamble. Range from obvious to wild. Quantity over polish.',
    temperature: 0.9,
    builtin: true,
  },
];

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function loadUserPresets(): PromptPreset[] {
  return safeParse<PromptPreset[]>(localStorage.getItem(USER_PRESETS_KEY), [])
    .map((p) => ({ ...p, builtin: false }));
}

function loadHiddenBuiltins(): string[] {
  return safeParse<string[]>(localStorage.getItem(HIDDEN_BUILTINS_KEY), []);
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `user:${crypto.randomUUID()}`;
  }
  return `user:${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

class PromptPresetStore {
  userPresets = $state<PromptPreset[]>(loadUserPresets());
  hiddenBuiltins = $state<string[]>(loadHiddenBuiltins());

  /** All visible presets (builtin + user, with hidden builtins filtered out). */
  get all(): PromptPreset[] {
    const hidden = new Set(this.hiddenBuiltins);
    return [
      ...BUILTIN_PRESETS.filter((p) => !hidden.has(p.id)),
      ...this.userPresets,
    ];
  }

  get(id: string): PromptPreset | null {
    return (
      BUILTIN_PRESETS.find((p) => p.id === id) ??
      this.userPresets.find((p) => p.id === id) ??
      null
    );
  }

  private persistUser() {
    try {
      localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(this.userPresets));
    } catch {
      /* ignore */
    }
  }

  private persistHidden() {
    try {
      localStorage.setItem(HIDDEN_BUILTINS_KEY, JSON.stringify(this.hiddenBuiltins));
    } catch {
      /* ignore */
    }
  }

  create(data: Omit<PromptPreset, 'id' | 'builtin'>): string {
    const preset: PromptPreset = { ...data, id: uuid(), builtin: false };
    this.userPresets = [...this.userPresets, preset];
    this.persistUser();
    return preset.id;
  }

  update(id: string, patch: Partial<Omit<PromptPreset, 'id' | 'builtin'>>) {
    if (id.startsWith('builtin:')) return; // built-ins are read-only
    this.userPresets = this.userPresets.map((p) =>
      p.id === id ? { ...p, ...patch } : p,
    );
    this.persistUser();
  }

  delete(id: string) {
    if (id.startsWith('builtin:')) {
      // Soft-hide built-in instead of deleting.
      if (!this.hiddenBuiltins.includes(id)) {
        this.hiddenBuiltins = [...this.hiddenBuiltins, id];
        this.persistHidden();
      }
      return;
    }
    this.userPresets = this.userPresets.filter((p) => p.id !== id);
    this.persistUser();
  }

  restoreBuiltin(id: string) {
    this.hiddenBuiltins = this.hiddenBuiltins.filter((x) => x !== id);
    this.persistHidden();
  }
}

export const promptPresets = new PromptPresetStore();
