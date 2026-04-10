import { Annotation } from '@codemirror/state';

/**
 * Annotation used to mark a transaction as a remote change from another pane.
 * Prevents infinite propagation loops and excludes from undo history.
 */
export const remoteChangeAnnotation = Annotation.define<boolean>();
