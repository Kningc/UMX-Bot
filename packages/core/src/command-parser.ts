export class CommandParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CommandParseError";
  }
}

export interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

export function parseCommand(input: string): ParsedCommand | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const separator = trimmed.search(/\s/u);
  const name = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const rawArgs = separator < 0 ? "" : trimmed.slice(separator).trim();

  return {
    name,
    args: parseArguments(rawArgs),
    rawArgs
  };
}

export function parseArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  let tokenStarted = false;

  const pushCurrent = (): void => {
    if (tokenStarted) {
      args.push(current);
      current = "";
      tokenStarted = false;
    }
  };

  for (const character of input) {
    if (escaping) {
      current += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      pushCurrent();
      continue;
    }

    current += character;
    tokenStarted = true;
  }

  if (escaping) {
    throw new CommandParseError("参数末尾不能是转义符");
  }
  if (quote) {
    throw new CommandParseError("参数中的引号没有闭合");
  }

  pushCurrent();
  return args;
}
