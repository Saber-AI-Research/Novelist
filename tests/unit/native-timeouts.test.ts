import { describe, expect, it } from 'vitest';

import nativeLifecycleSource from '../e2e/native/specs/native-lifecycle.spec.ts?raw';
import {
  NATIVE_FIXTURE_TIMEOUT_MS,
  NATIVE_WORKFLOW_TIMEOUT_MS,
  runNativeStage,
} from '../e2e/native/native-timeouts';

describe('native harness timeout policy', () => {
  it('gives bounded cold startup a separate, larger budget than the workflow', () => {
    expect(NATIVE_FIXTURE_TIMEOUT_MS).toBe(480_000);
    expect(NATIVE_WORKFLOW_TIMEOUT_MS).toBe(120_000);
    expect(NATIVE_FIXTURE_TIMEOUT_MS).toBeGreaterThan(NATIVE_WORKFLOW_TIMEOUT_MS);
  });

  it('never disables either timeout', () => {
    expect(NATIVE_FIXTURE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(NATIVE_WORKFLOW_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('records bounded stage completion', async () => {
    const messages: string[] = [];
    const result = await runNativeStage('bridge', 100, async () => 'ready', (message) => {
      messages.push(message);
    });

    expect(result).toBe('ready');
    expect(messages[0]).toMatch(/^native_stage=bridge state=begin timeout_ms=100 at=/);
    expect(messages[1]).toMatch(/^native_stage=bridge state=pass elapsed_ms=\d+ at=/);
  });

  it('fails a stage at its local deadline and records the label', async () => {
    const messages: string[] = [];

    await expect(runNativeStage('snapshot', 5, () => new Promise(() => {}), (message) => {
      messages.push(message);
    })).rejects.toThrow('native stage "snapshot" timed out after 5ms');

    expect(messages.at(-1)).toMatch(/^native_stage=snapshot state=fail elapsed_ms=\d+ error=/);
  });

  it('executes every lifecycle stage through the bounded stage runner', () => {
    const stageLabels = ['project', 'clipboard', 'watcher', 'rename', 'window_prepare', 'snapshot'];
    const missingStages = stageLabels.filter((label) => (
      !new RegExp(`runNativeStage\\(\\s*['"]${label}['"]\\s*,`).test(nativeLifecycleSource)
    ));

    expect(missingStages).toEqual([]);
    expect(nativeLifecycleSource).not.toContain('async function logStage');
    expect(nativeLifecycleSource).not.toContain('await logStage(');
  });
});
