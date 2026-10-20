export function getNextBlueprintChapterIndex(
  chapterCount: number,
  appliedChapterIndexes: Iterable<number>,
): number | null {
  const normalizedChapterCount = Number.isInteger(chapterCount) && chapterCount > 0
    ? chapterCount
    : 0;
  const applied = new Set(
    Array.from(appliedChapterIndexes).filter(index => (
      Number.isInteger(index) && index >= 0 && index < normalizedChapterCount
    )),
  );

  for (let index = 0; index < normalizedChapterCount; index += 1) {
    if (!applied.has(index)) return index;
  }
  return null;
}
