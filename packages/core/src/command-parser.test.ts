import { describe, expect, it } from "vitest";
import {
  CommandParseError,
  parseArguments,
  parseCommand
} from "./command-parser.js";

describe("command parser", () => {
  it("parses quoted, escaped and empty arguments", () => {
    expect(
      parseCommand(`echo "hello world" '中文 参数' plain\\ value ""`)
    ).toEqual({
      name: "echo",
      args: ["hello world", "中文 参数", "plain value", ""],
      rawArgs: `"hello world" '中文 参数' plain\\ value ""`
    });
  });

  it("returns undefined for empty input", () => {
    expect(parseCommand("   ")).toBeUndefined();
  });

  it("rejects unclosed quotes and trailing escapes", () => {
    expect(() => parseArguments(`"unclosed`)).toThrow(CommandParseError);
    expect(() => parseArguments("trailing\\")).toThrow(
      "参数末尾不能是转义符"
    );
  });
});
