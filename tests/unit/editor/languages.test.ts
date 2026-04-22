import { describe, it, expect } from 'vitest';
import { LanguageDescription } from '@codemirror/language';
import { codeLanguages } from '$lib/editor/languages';

/**
 * [precision] languages — asserts the lazy-loaded language table has the
 * expected shape: every entry is a LanguageDescription, each has an async
 * `load`, and alias-based lookup resolves the declared languages.
 * Does NOT resolve the dynamic imports — parser bundles are heavy and
 * testing the import path is integration territory.
 */

describe('[precision] codeLanguages', () => {
  it('exposes a non-empty array of LanguageDescription', () => {
    expect(Array.isArray(codeLanguages)).toBe(true);
    expect(codeLanguages.length).toBeGreaterThan(0);
    for (const desc of codeLanguages) {
      expect(desc).toBeInstanceOf(LanguageDescription);
    }
  });

  it('gives every entry an async `load` function', () => {
    for (const desc of codeLanguages) {
      expect(typeof desc.load).toBe('function');
    }
  });

  it('includes the expected language names', () => {
    const names = codeLanguages.map(d => d.name).sort();
    const expected = [
      'C++', 'CSS', 'Go', 'HTML', 'Java', 'JSON', 'JavaScript',
      'Markdown', 'Python', 'Rust', 'SQL', 'TypeScript', 'XML', 'YAML',
    ].sort();
    expect(names).toEqual(expected);
  });

  it('matches common aliases via LanguageDescription.matchLanguageName', () => {
    expect(LanguageDescription.matchLanguageName(codeLanguages, 'rs')?.name).toBe('Rust');
    expect(LanguageDescription.matchLanguageName(codeLanguages, 'py')?.name).toBe('Python');
    expect(LanguageDescription.matchLanguageName(codeLanguages, 'ts')?.name).toBe('TypeScript');
    expect(LanguageDescription.matchLanguageName(codeLanguages, 'jsx')?.name).toBe('JavaScript');
    expect(LanguageDescription.matchLanguageName(codeLanguages, 'svg')?.name).toBe('XML');
    expect(LanguageDescription.matchLanguageName(codeLanguages, 'yml')?.name).toBe('YAML');
    expect(LanguageDescription.matchLanguageName(codeLanguages, 'golang')?.name).toBe('Go');
    expect(LanguageDescription.matchLanguageName(codeLanguages, 'hpp')?.name).toBe('C++');
  });

  it('returns null for an unknown alias', () => {
    expect(LanguageDescription.matchLanguageName(codeLanguages, 'brainfuck')).toBeNull();
  });

  it('every lazy `load` resolves to a LanguageSupport (or language-like) value', async () => {
    // Resolving every import is heavy but it's the only way coverage sees each
    // `load` arrow. Run in parallel so the whole thing stays under a second.
    const results = await Promise.all(codeLanguages.map(async (desc) => {
      const support = await desc.load();
      return support;
    }));
    for (const r of results) {
      expect(r).toBeDefined();
      // LanguageSupport from CM6 exposes `language` and `extension`.
      expect((r as any).language || (r as any).extension).toBeDefined();
    }
  });
});
