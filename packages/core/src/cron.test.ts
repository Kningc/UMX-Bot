import { describe, expect, it } from "vitest";
import { CronSchedule } from "./cron.js";

const utc = (text: string): Date => new Date(text);

describe("CronSchedule", () => {
  it("finds the next minute for a wildcard schedule", () => {
    const next = CronSchedule.parse("* * * * *").next(
      utc("2026-01-01T00:00:10Z"),
      "utc"
    );
    expect(next?.toISOString()).toBe("2026-01-01T00:01:00.000Z");
  });

  it("supports lists, ranges and steps", () => {
    const schedule = CronSchedule.parse("*/15 9-10 * * *");
    const times: string[] = [];
    let cursor = utc("2026-01-01T00:00:00Z");
    for (let index = 0; index < 5; index += 1) {
      cursor = schedule.next(cursor, "utc") as Date;
      times.push(cursor.toISOString().slice(11, 16));
    }
    expect(times).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00"]);
    expect(
      CronSchedule.parse("5,50 0 1 1 *")
        .next(utc("2026-01-01T00:05:00Z"), "utc")
        ?.toISOString()
    ).toBe("2026-01-01T00:50:00.000Z");
    expect(
      CronSchedule.parse("10/20 0 1 1 *")
        .next(utc("2026-01-01T00:00:00Z"), "utc")
        ?.toISOString()
    ).toBe("2026-01-01T00:10:00.000Z");
  });

  it("treats 0 and 7 as Sunday and ORs restricted day fields", () => {
    // 2026-01-04 is a Sunday.
    expect(
      CronSchedule.parse("0 0 * * 7")
        .next(utc("2026-01-01T00:00:00Z"), "utc")
        ?.toISOString()
    ).toBe("2026-01-04T00:00:00.000Z");
    // Day 10 OR Sunday: the Sunday comes first.
    expect(
      CronSchedule.parse("0 0 10 * 0")
        .next(utc("2026-01-01T00:00:00Z"), "utc")
        ?.toISOString()
    ).toBe("2026-01-04T00:00:00.000Z");
  });

  it("finds rare dates and gives up on impossible ones", () => {
    expect(
      CronSchedule.parse("0 0 29 2 *")
        .next(utc("2026-01-01T00:00:00Z"), "utc")
        ?.toISOString()
    ).toBe("2028-02-29T00:00:00.000Z");
    expect(
      CronSchedule.parse("0 0 31 2 *").next(utc("2026-01-01T00:00:00Z"), "utc")
    ).toBeUndefined();
  });

  it("works in local time", () => {
    const next = CronSchedule.parse("30 12 * * *").next(
      new Date(2026, 0, 1, 0, 0),
      "local"
    );
    expect(next?.getHours()).toBe(12);
    expect(next?.getMinutes()).toBe(30);
  });

  it("rejects malformed expressions", () => {
    for (const bad of [
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "*/0 * * * *",
      "a * * * *",
      "5-1 * * * *",
      "1/2/3 * * * *",
      ", * * * *",
      "1-2-3 * * * *"
    ]) {
      expect(() => CronSchedule.parse(bad)).toThrow();
    }
  });
});
