/**
 * Lazy-loaded language support for fenced code blocks.
 *
 * Each language uses LanguageDescription.of() with a dynamic import,
 * so parsers are only fetched when the user actually has a code block
 * of that type in their document.  This keeps the initial bundle small.
 */
import { LanguageDescription } from '@codemirror/language';

export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'C++',
    alias: ['cpp', 'c', 'cxx', 'c++', 'h', 'hpp'],
    load: () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  }),
  LanguageDescription.of({
    name: 'CSS',
    alias: ['css'],
    load: () => import('@codemirror/lang-css').then(m => m.css()),
  }),
  LanguageDescription.of({
    name: 'Go',
    alias: ['go', 'golang'],
    load: () => import('@codemirror/lang-go').then(m => m.go()),
  }),
  LanguageDescription.of({
    name: 'HTML',
    alias: ['html', 'htm'],
    load: () => import('@codemirror/lang-html').then(m => m.html()),
  }),
  LanguageDescription.of({
    name: 'Java',
    alias: ['java'],
    load: () => import('@codemirror/lang-java').then(m => m.java()),
  }),
  LanguageDescription.of({
    name: 'JavaScript',
    alias: ['javascript', 'js', 'jsx'],
    load: () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  }),
  LanguageDescription.of({
    name: 'JSON',
    alias: ['json'],
    load: () => import('@codemirror/lang-json').then(m => m.json()),
  }),
  LanguageDescription.of({
    name: 'Markdown',
    alias: ['markdown', 'md'],
    load: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  }),
  LanguageDescription.of({
    name: 'Python',
    alias: ['python', 'py'],
    load: () => import('@codemirror/lang-python').then(m => m.python()),
  }),
  LanguageDescription.of({
    name: 'Rust',
    alias: ['rust', 'rs'],
    load: () => import('@codemirror/lang-rust').then(m => m.rust()),
  }),
  LanguageDescription.of({
    name: 'SQL',
    alias: ['sql'],
    load: () => import('@codemirror/lang-sql').then(m => m.sql()),
  }),
  LanguageDescription.of({
    name: 'TypeScript',
    alias: ['typescript', 'ts', 'tsx'],
    load: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
  }),
  LanguageDescription.of({
    name: 'XML',
    alias: ['xml', 'svg'],
    load: () => import('@codemirror/lang-xml').then(m => m.xml()),
  }),
  LanguageDescription.of({
    name: 'YAML',
    alias: ['yaml', 'yml'],
    load: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  }),
];
