export type AiAgentNewSessionRequest = Readonly<{
  id: number;
  projectDir: string | null;
}>;

export type AiAgentNewSessionRequestResult = 'handled' | 'defer' | 'rejected';
type AiAgentNewSessionHandler = (
  request: AiAgentNewSessionRequest,
) => AiAgentNewSessionRequestResult | Promise<AiAgentNewSessionRequestResult>;

let nextRequestId = 0;
const pendingRequests: AiAgentNewSessionRequest[] = [];
let activeHandler: AiAgentNewSessionHandler | null = null;
let draining = false;
let drainRequested = false;

export function requestAiAgentNewSession(projectDir: string | null): void {
  pendingRequests.push({ id: ++nextRequestId, projectDir });
  void drainPendingRequests();
}

export function registerAiAgentNewSessionHandler(handler: AiAgentNewSessionHandler): () => void {
  activeHandler = handler;
  void drainPendingRequests();
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

export function flushAiAgentNewSessionRequests(): void {
  void drainPendingRequests();
}

async function drainPendingRequests(): Promise<void> {
  if (draining) {
    drainRequested = true;
    return;
  }
  if (!activeHandler) return;
  draining = true;
  try {
    while (pendingRequests.length > 0) {
      const handler: AiAgentNewSessionHandler | null = activeHandler;
      if (!handler) return;
      const request = pendingRequests[0];
      let result: AiAgentNewSessionRequestResult;
      try {
        result = await handler(request);
      } catch (error) {
        console.warn('[ai-agent] new-session command failed', error);
        result = 'rejected';
      }
      if (result === 'defer') return;
      if (pendingRequests[0]?.id === request.id) pendingRequests.shift();
      if (activeHandler !== handler) return;
    }
  } finally {
    draining = false;
    if (drainRequested) {
      drainRequested = false;
      void drainPendingRequests();
    }
  }
}
