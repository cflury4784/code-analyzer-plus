/**
 * Partition an array of items into groups where no group exceeds `maxGroupBytes`
 * when serialized to JSON. Items larger than the limit are placed in their own
 * single-item group.
 *
 * Pure function — no I/O, no side effects.
 */
export function groupByByteSize<T>(items: T[], maxGroupBytes: number): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentSize = 0;

  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (currentSize + size > maxGroupBytes && current.length > 0) {
      groups.push(current);
      current = [item];
      currentSize = size;
    } else {
      current.push(item);
      currentSize += size;
    }
  }
  if (current.length > 0) groups.push(current);

  return groups;
}
