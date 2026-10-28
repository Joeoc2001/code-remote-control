export function timestampMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    throw new Error(`Unparseable timestamp ${JSON.stringify(timestamp)}`);
  }
  return ms;
}

export function latestTimestamp(timestamps: string[]): string | null {
  return timestamps.reduce<string | null>(
    (latest, timestamp) => (latest === null || timestampMs(timestamp) > timestampMs(latest) ? timestamp : latest),
    null,
  );
}
