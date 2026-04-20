/**
 * Browser prompt for a 1-based line number. Skips the jump if the user
 * cancels, leaves the input empty, or enters something non-positive.
 */
export function promptGoToLine(promptText: string, jump: (line: number) => void) {
  const input = prompt(promptText);
  if (!input) return;
  const line = parseInt(input, 10);
  if (isNaN(line) || line < 1) return;
  jump(line);
}
