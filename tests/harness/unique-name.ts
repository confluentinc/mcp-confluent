/** Generates a unique `int-<slug>-<timestamp>-<random>` name for a test-side resources. */
export function uniqueName(slug: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `int-${slug}-${Date.now()}-${random}`;
}
