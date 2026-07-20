import type { Theme } from '$lib/themes';
import { themeToCSS } from '$lib/themes';

type CommandResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: string };

interface StageThemeCssDeps {
  stageCss: (requestId: string, css: string) => Promise<CommandResult<string>>;
  deleteItem: (path: string) => Promise<CommandResult<null>>;
  requestId: string;
  isCancelled: () => boolean;
  warn?: (message: string) => void;
}

type StageThemeCssResult =
  | { status: 'ok'; args: string[] }
  | { status: 'cancelled'; warning?: string }
  | { status: 'error'; message: string };

export const EXPORT_CSS_STAGE_ERROR = 'Could not prepare export stylesheet. Check disk permissions or free space.';
export const EXPORT_CSS_CANCEL_CLEANUP_WARNING =
  'Export cancelled, but the temporary stylesheet could not be removed.';

export async function stageThemeCssForExport(
  theme: Theme,
  deps: StageThemeCssDeps,
): Promise<StageThemeCssResult> {
  const themeCSS = themeToCSS(theme);
  const fullCSS = `${themeCSS}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; background: var(--novelist-bg); color: var(--novelist-text); line-height: 1.7; }
h1, h2, h3, h4, h5, h6 { color: var(--novelist-heading-color); }
a { color: var(--novelist-link-color); }
code { background: var(--novelist-code-bg); padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
pre { background: var(--novelist-code-bg); padding: 16px; border-radius: 6px; overflow-x: auto; }
blockquote { border-left: 3px solid var(--novelist-blockquote-border); padding-left: 16px; color: var(--novelist-text-secondary); font-style: italic; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; }
th, td { border: 1px solid var(--novelist-border); padding: 8px 12px; text-align: left; }
th { background: var(--novelist-bg-secondary); font-weight: 600; }
hr { border: none; border-top: 1px solid var(--novelist-border); margin: 24px 0; }
img { max-width: 100%; border-radius: 6px; }`;

  const cssWrite = await deps.stageCss(deps.requestId, fullCSS);
  if (cssWrite.status !== 'ok') {
    return { status: 'error', message: EXPORT_CSS_STAGE_ERROR };
  }
  const cssPath = cssWrite.data;

  if (deps.isCancelled()) {
    const cleanup = await deps.deleteItem(cssPath);
    if (cleanup.status !== 'ok') {
      deps.warn?.(EXPORT_CSS_CANCEL_CLEANUP_WARNING);
      return { status: 'cancelled', warning: EXPORT_CSS_CANCEL_CLEANUP_WARNING };
    }
    return { status: 'cancelled' };
  }

  return { status: 'ok', args: ['--include-in-header', cssPath] };
}
