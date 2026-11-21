/** Thrown by an argument schema; the message is shown to the user as-is. */
export class CommandArgumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CommandArgumentError";
  }
}

export interface CommandArgsInput {
  args: readonly string[];
  rawArgs: string;
}

/**
 * Turns the raw argument list into a typed value.
 *
 * Compatible in spirit with `SettingsSchema`: anything with a `parse` that
 * throws on bad input works. Throw `CommandArgumentError` for a friendly
 * message; any other error is reported generically.
 */
export interface CommandArgsSchema<T> {
  parse(input: CommandArgsInput): T;
  /** Argument syntax shown in help, used when the command has no `usage`. */
  readonly usage?: string;
}

interface ArgBase {
  description?: string;
  /** Omit the argument when absent instead of failing. */
  optional?: boolean;
}

export type ArgDefinition = ArgBase &
  (
    | {
        type: "string";
        choices?: readonly string[];
        /** Consume every remaining argument, joined by a space. Must be last. */
        rest?: boolean;
      }
    | { type: "number"; min?: number; max?: number }
    | { type: "integer"; min?: number; max?: number }
    | { type: "boolean" }
  );

export type ArgSpec = Readonly<Record<string, ArgDefinition>>;

type ArgValue<D> = D extends { type: "number" | "integer" }
  ? number
  : D extends { type: "boolean" }
    ? boolean
    : string;

export type ParsedArgs<S extends ArgSpec> = {
  [K in keyof S as S[K] extends { optional: true } ? never : K]: ArgValue<S[K]>;
} & {
  [K in keyof S as S[K] extends { optional: true } ? K : never]?: ArgValue<
    S[K]
  >;
};

const TRUE_WORDS = new Set(["true", "yes", "on", "1", "开", "是"]);
const FALSE_WORDS = new Set(["false", "no", "off", "0", "关", "否"]);

/**
 * Declares positional arguments. Property order is argument order.
 *
 * ```ts
 * args: defineArgs({
 *   host: { type: "string" },
 *   port: { type: "integer", optional: true, min: 1, max: 65535 }
 * })
 * ```
 */
export function defineArgs<const S extends ArgSpec>(
  spec: S
): CommandArgsSchema<ParsedArgs<S>> {
  const entries = Object.entries(spec);
  entries.forEach(([name, definition], index) => {
    if (
      definition.type === "string" &&
      definition.rest &&
      index !== entries.length - 1
    ) {
      throw new Error(`rest argument "${name}" must be the last argument`);
    }
  });

  const usage = entries
    .map(([name, definition]) => {
      const label =
        definition.type === "string" && definition.choices
          ? definition.choices.join("|")
          : name;
      const text =
        definition.type === "string" && definition.rest ? `${label}...` : label;
      return definition.optional ? `[${text}]` : `<${text}>`;
    })
    .join(" ");

  return {
    ...(usage ? { usage } : {}),
    parse({ args }) {
      const result: Record<string, unknown> = {};
      let index = 0;
      for (const [name, definition] of entries) {
        if (definition.type === "string" && definition.rest) {
          const remaining = args.slice(index);
          index = args.length;
          if (remaining.length === 0) {
            if (!definition.optional) {
              throw new CommandArgumentError(`缺少参数 ${name}`);
            }
            continue;
          }
          result[name] = checkChoice(name, remaining.join(" "), definition);
          continue;
        }
        const raw = args[index];
        index += 1;
        if (raw === undefined) {
          if (!definition.optional) {
            throw new CommandArgumentError(`缺少参数 ${name}`);
          }
          continue;
        }
        result[name] = convert(name, raw, definition);
      }
      if (index < args.length) {
        throw new CommandArgumentError(`多余的参数：${args[index]}`);
      }
      return result as ParsedArgs<S>;
    }
  };
}

function checkChoice(
  name: string,
  value: string,
  definition: ArgDefinition
): string {
  if (
    definition.type === "string" &&
    definition.choices &&
    !definition.choices.includes(value)
  ) {
    throw new CommandArgumentError(
      `参数 ${name} 必须是 ${definition.choices.join("、")} 之一`
    );
  }
  return value;
}

function convert(
  name: string,
  raw: string,
  definition: ArgDefinition
): string | number | boolean {
  switch (definition.type) {
    case "string":
      return checkChoice(name, raw, definition);
    case "boolean": {
      const word = raw.toLowerCase();
      if (TRUE_WORDS.has(word)) {
        return true;
      }
      if (FALSE_WORDS.has(word)) {
        return false;
      }
      throw new CommandArgumentError(`参数 ${name} 必须是 true 或 false`);
    }
    case "number":
    case "integer": {
      const value = Number(raw);
      if (
        raw.trim() === "" ||
        !Number.isFinite(value) ||
        (definition.type === "integer" && !Number.isInteger(value))
      ) {
        throw new CommandArgumentError(
          `参数 ${name} 必须是${definition.type === "integer" ? "整数" : "数字"}`
        );
      }
      if (definition.min !== undefined && value < definition.min) {
        throw new CommandArgumentError(
          `参数 ${name} 不能小于 ${definition.min}`
        );
      }
      if (definition.max !== undefined && value > definition.max) {
        throw new CommandArgumentError(
          `参数 ${name} 不能大于 ${definition.max}`
        );
      }
      return value;
    }
  }
}
