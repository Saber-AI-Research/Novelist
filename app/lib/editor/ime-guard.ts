import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

const setComposing = StateEffect.define<boolean>();
const nativeE2eComposition = new WeakMap<EditorView, boolean>();

export const imeComposingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setComposing)) return effect.value;
    }
    return value;
  },
});

export const imeGuardPlugin = ViewPlugin.fromClass(class {
  private settleTimer: number | undefined;

  constructor(readonly view: EditorView) {}

  private cancelSettle() {
    if (this.settleTimer !== undefined) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
  }

  start() {
    // A previous compositionend may still be waiting for its final input.
    // It must never clear the guard or notify watchers during this session.
    this.cancelSettle();
    this.view.dispatch({ effects: setComposing.of(true) });
  }

  end() {
    this.cancelSettle();
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = undefined;
      this.view.dispatch({ effects: setComposing.of(false) });
      window.dispatchEvent(new CustomEvent('novelist-composition-end'));
    }, 20);
  }

  destroy() {
    this.cancelSettle();
    nativeE2eComposition.delete(this.view);
  }
}, {
  provide: () => imeComposingField,
  eventHandlers: {
    compositionstart(event, view) {
      if (!(event.target instanceof Element) || event.target.closest('[contenteditable]') !== view.contentDOM) return;
      this.start();
    },
    compositionend(event, view) {
      if (!(event.target instanceof Element) || event.target.closest('[contenteditable]') !== view.contentDOM) return;
      this.end();
    },
  },
});

export function isImeComposing(view: EditorView): boolean {
  const testWindow = window as typeof window & { __PW_ACTIVE__?: boolean };
  if (testWindow.__PW_ACTIVE__ && nativeE2eComposition.has(view)) {
    return nativeE2eComposition.get(view) === true;
  }
  return Boolean(view.compositionStarted || view.composing || view.state.field(imeComposingField, false));
}

export function setNativeE2eComposition(view: EditorView, composing: boolean): void {
  const testWindow = window as typeof window & { __PW_ACTIVE__?: boolean };
  if (!testWindow.__PW_ACTIVE__) throw new Error('Native E2E composition seam is unavailable');
  nativeE2eComposition.set(view, composing);
  view.dispatch({ effects: setComposing.of(composing) });
  if (!composing) window.dispatchEvent(new CustomEvent('novelist-composition-end'));
}
