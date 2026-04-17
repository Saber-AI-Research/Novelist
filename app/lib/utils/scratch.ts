/** Pattern for scratch file names: novelist_scratch_<unix_millis>.md */
const SCRATCH_PATTERN = /^novelist_scratch_\d+\.md$/;

/** Check if a file path points to a scratch (temporary) file by its filename pattern. */
export function isScratchFile(filePath: string): boolean {
  const fileName = filePath.split('/').pop() || '';
  return SCRATCH_PATTERN.test(fileName);
}

/** Counter for generating display names: Untitled, Untitled 2, Untitled 3, ... */
let scratchCounter = 0;

export function nextScratchDisplayName(): string {
  scratchCounter += 1;
  return scratchCounter === 1 ? 'Untitled' : `Untitled ${scratchCounter}`;
}
