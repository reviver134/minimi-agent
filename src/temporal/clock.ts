// "Now" comes from a Clock so tests and evals can fix the time.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string): Clock {
  const time = new Date(at).getTime();
  return { now: () => new Date(time) };
}

/** True for a timezone name the runtime knows, such as "Asia/Kolkata". */
export function isTimezone(name: unknown): name is string {
  if (typeof name !== 'string' || !name) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
