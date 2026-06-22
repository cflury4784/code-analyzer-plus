export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}
