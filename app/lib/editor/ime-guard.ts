import { StateField, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

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

export const imeGuardPlugin = EditorView.domEventHandlers({
  compositionstart(event, view) {
    view.dispatch({ effects: setComposing.of(true) });
  },
  compositionend(event, view) {
    // Small delay to let the final input settle
    setTimeout(() => {
      view.dispatch({ effects: setComposing.of(false) });
      window.dispatchEvent(new CustomEvent('novelist-composition-end'));
    }, 20);
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
