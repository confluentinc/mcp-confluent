/**
 * Generates a unique `int-<slug>-<timestamp>-<random>` name for a test-side
 * resource (Kafka topic, SR subject, etc.). The `int-` prefix lets cleanup
 * sweeps tell test-created resources from production ones, mirroring the
 * `e2e-` convention used by confluentinc/vscode.
 */
export function uniqueName(slug: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `int-${slug}-${Date.now()}-${random}`;
}
