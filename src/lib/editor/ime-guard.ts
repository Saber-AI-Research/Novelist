import { StateField, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const setComposing = StateEffect.define<boolean>();

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
    }, 20);
  },
});
