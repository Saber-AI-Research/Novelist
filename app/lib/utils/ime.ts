/** True while a CJK/IME composition owns the key (WebKit may send the commit Enter with isComposing=false but keyCode 229). */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}
