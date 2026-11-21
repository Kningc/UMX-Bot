export type CronTimezone = "local" | "utc";

interface Field {
  /** Allowed values; `any` marks an unrestricted `*` field. */
  values: ReadonlySet<number>;
  any: boolean;
}

const MAX_SEARCH_YEARS = 5;

export class CronSchedule {
  private constructor(
    private readonly minutes: Field,
    private readonly hours: Field,
    private readonly days: Field,
    private readonly months: Field,
    private readonly weekdays: Field
  ) {}

  public static parse(expression: string): CronSchedule {
    const parts = expression.trim().split(/\s+/u);
    if (parts.length !== 5) {
      throw new Error(
        `cron expression "${expression}" must have 5 fields: minute hour day-of-month month day-of-week`
      );
    }
    const [minute, hour, day, month, weekday] = parts as [
      string,
      string,
      string,
      string,
      string
    ];
    const weekdays = parseField(weekday, 0, 7, "day-of-week");
    // Both 0 and 7 mean Sunday.
    if (weekdays.values.has(7)) {
      (weekdays.values as Set<number>).delete(7);
      (weekdays.values as Set<number>).add(0);
    }
    return new CronSchedule(
      parseField(minute, 0, 59, "minute"),
      parseField(hour, 0, 23, "hour"),
      parseField(day, 1, 31, "day-of-month"),
      parseField(month, 1, 12, "month"),
      weekdays
    );
  }

  /** First fire time strictly after `after`, or undefined if none exists. */
  public next(after: Date, timezone: CronTimezone = "local"): Date | undefined {
    const utc = timezone === "utc";
    const parts = (date: Date) =>
      utc
        ? {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hour: date.getUTCHours(),
            minute: date.getUTCMinutes(),
            weekday: date.getUTCDay()
          }
        : {
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate(),
            hour: date.getHours(),
            minute: date.getMinutes(),
            weekday: date.getDay()
          };
    const build = (
      year: number,
      month: number,
      day: number,
      hour: number,
      minute: number
    ): Date =>
      utc
        ? new Date(Date.UTC(year, month - 1, day, hour, minute))
        : new Date(year, month - 1, day, hour, minute);

    // Start at the next whole minute.
    let cursor = new Date(
      Math.floor(after.getTime() / 60_000) * 60_000 + 60_000
    );
    const limit = after.getTime() + MAX_SEARCH_YEARS * 366 * 86_400_000;

    while (cursor.getTime() <= limit) {
      const p = parts(cursor);
      if (!this.months.values.has(p.month)) {
        cursor = build(p.year, p.month + 1, 1, 0, 0);
        continue;
      }
      if (!this.dayMatches(p.day, p.weekday)) {
        cursor = build(p.year, p.month, p.day + 1, 0, 0);
        continue;
      }
      if (!this.hours.values.has(p.hour)) {
        cursor = build(p.year, p.month, p.day, p.hour + 1, 0);
        continue;
      }
      if (!this.minutes.values.has(p.minute)) {
        cursor = build(p.year, p.month, p.day, p.hour, p.minute + 1);
        continue;
      }
      return cursor;
    }
    return undefined;
  }

  private dayMatches(day: number, weekday: number): boolean {
    const dayOk = this.days.values.has(day);
    const weekdayOk = this.weekdays.values.has(weekday);
    if (this.days.any || this.weekdays.any) {
      return dayOk && weekdayOk;
    }
    return dayOk || weekdayOk;
  }
}

function parseField(
  source: string,
  min: number,
  max: number,
  name: string
): Field {
  const values = new Set<number>();
  let any = false;
  for (const item of source.split(",")) {
    const [rangePart, stepPart, ...extra] = item.split("/");
    if (extra.length > 0 || rangePart === undefined || rangePart === "") {
      throw new Error(`invalid cron ${name} field "${source}"`);
    }
    const step =
      stepPart === undefined ? 1 : parseNumber(stepPart, name, source);
    if (step < 1) {
      throw new Error(`cron ${name} step must be at least 1`);
    }
    let from: number;
    let to: number;
    if (rangePart === "*") {
      from = min;
      to = max;
      if (stepPart === undefined) {
        any = true;
      }
    } else if (rangePart.includes("-")) {
      const [start, end, ...more] = rangePart.split("-");
      if (more.length > 0 || start === undefined || end === undefined) {
        throw new Error(`invalid cron ${name} field "${source}"`);
      }
      from = parseNumber(start, name, source);
      to = parseNumber(end, name, source);
    } else {
      from = parseNumber(rangePart, name, source);
      to = stepPart === undefined ? from : max;
    }
    if (from < min || to > max || from > to) {
      throw new Error(
        `cron ${name} field "${source}" is out of range ${min}-${max}`
      );
    }
    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }
  return { values, any };
}

function parseNumber(text: string, name: string, source: string): number {
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid cron ${name} field "${source}"`);
  }
  return Number(text);
}
