/**
 * Shared rendering for the pagination `metadata` block that Confluent Cloud
 * list endpoints return. Individual endpoints type the link fields as either a
 * plain string or a validated URL; both narrow to `string`, so the per-handler
 * metadata types are assignable to this common shape.
 */
export type PaginationMetadata = {
  first?: string;
  last?: string;
  prev?: string;
  next?: string;
  total_size?: number;
};

/**
 * Renders the pagination text block. A present-but-empty metadata object still
 * emits the header; absent metadata emits nothing. Rows whose value is absent
 * are omitted — the filter tests for `undefined`, not truthiness, so a
 * legitimate `total_size: 0` still renders.
 */
export function renderPaginationSection(
  metadata: PaginationMetadata | undefined,
  totalLabel: string,
): string {
  if (!metadata) {
    return "";
  }
  const rows: ReadonlyArray<[string, string | number | undefined]> = [
    [totalLabel, metadata.total_size],
    ["First Page", metadata.first],
    ["Last Page", metadata.last],
    ["Previous Page", metadata.prev],
    ["Next Page", metadata.next],
  ];
  const body = rows
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `\n  ${label}: ${value}`)
    .join("");
  return `
Pagination:${body}
`;
}

/**
 * Builds the `_meta` pagination object (the four navigation links, without
 * total_size), or undefined when no metadata was returned.
 */
export function toPaginationMeta(metadata: PaginationMetadata | undefined) {
  return metadata
    ? {
        first: metadata.first,
        last: metadata.last,
        prev: metadata.prev,
        next: metadata.next,
      }
    : undefined;
}
