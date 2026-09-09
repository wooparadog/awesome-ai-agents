export function dayBounds(now: number, timezone: string): [number, number] {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const key = (n: number) => fmt.format(new Date(n));
  const today = key(now);
  const boundary = (end: boolean) => {
    let lo = now - 36 * 3600000,
      hi = now + 36 * 3600000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (end ? key(mid) <= today : key(mid) < today) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  return [boundary(false), boundary(true)];
}
