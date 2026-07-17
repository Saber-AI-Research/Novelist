import type { StyledCopyWarning } from './types';

export interface WarningCollector {
  add(warning: StyledCopyWarning): void;
  values(): StyledCopyWarning[];
}

export function createWarningCollector(): WarningCollector {
  const seen = new Set<string>();
  const warnings: StyledCopyWarning[] = [];

  return {
    add(warning) {
      const key = JSON.stringify([warning.code, warning.payload ?? null]);
      if (seen.has(key)) return;
      seen.add(key);
      warnings.push({ ...warning });
    },
    values() {
      return warnings.map((warning) => ({ ...warning }));
    },
  };
}
