/**
 * Switches the process's time zone to `zone` now and returns what puts the earlier one back. Bun
 * keeps a zone once set, even when `TZ` is set to undefined, so a file that only assigns `TZ` leaves
 * its zone to every file after it; this restores by the earlier zone's name. (Deleting `TZ` instead
 * leaves Bun ignoring every later change to it.)
 */
export function setTimeZone(zone: string): () => void {
  const before = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = zone;
  return () => {
    process.env.TZ = before;
  };
}
