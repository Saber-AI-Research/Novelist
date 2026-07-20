import { expect, it, vi } from 'vitest';
import {
  registerAiAgentNewSessionHandler,
  requestAiAgentNewSession,
} from '$lib/components/ai-agent/new-session-requests';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it('[contract] does not replay a handled new-session request after handler remount', async () => {
  const started = deferred();
  const persistence = deferred();
  const firstHandler = vi.fn(async () => {
    started.resolve();
    await persistence.promise;
    return 'handled' as const;
  });
  const unregisterFirst = registerAiAgentNewSessionHandler(firstHandler);

  requestAiAgentNewSession('/project-a');
  await started.promise;
  unregisterFirst();

  const secondHandler = vi.fn(() => 'handled' as const);
  const unregisterSecond = registerAiAgentNewSessionHandler(secondHandler);
  persistence.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(firstHandler).toHaveBeenCalledOnce();
  expect(secondHandler).not.toHaveBeenCalled();
  unregisterSecond();
});
