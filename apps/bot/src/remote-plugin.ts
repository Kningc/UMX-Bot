import { type ChildProcess, spawn } from "node:child_process";
import { assertPluginVersion } from "@qq-bot/core";
import type {
  BotPlugin,
  ChatScope,
  CommandDefinition,
  Counter,
  Dispose,
  Gauge,
  Histogram,
  IncomingMessage,
  Logger,
  MessageContent,
  OutgoingMessage,
  PluginContext,
  PluginHelpDefinition,
  PluginPermission,
  ScopedSettings,
  SentMessage,
  SettingsScope,
  SubcommandDefinition
} from "@qq-bot/plugin-sdk";
import {
  type ArgDefinition,
  type ArgSpec,
  defineArgs,
  PermissionError,
  SUPPORTED_PLUGIN_API_VERSIONS
} from "@qq-bot/plugin-sdk";
import { ReplyWindow, type ReplyWindowOptions } from "./remote-reply-window.js";
import { JsonRpcPeer, RPC_CODES, RpcError } from "./remote-rpc.js";

/** Newest version of the stdio protocol (docs/remote-plugins.md). */
export const REMOTE_PROTOCOL_VERSION = 1.1;
/** Versions a child may announce in `hello`. */
export const SUPPORTED_REMOTE_PROTOCOLS: readonly number[] = [1, 1.1];

/** Permissions the protocol can honour for a remote plugin. */
export const REMOTE_PERMISSIONS = [
  "messages.active",
  "events.emit",
  "scheduler"
] as const;

export interface RemotePluginRestartPolicy {
  /** Consecutive crashes tolerated before the plugin is left stopped. */
  maxRestarts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A child that stays up this long resets the crash counter. */
  stableAfterMs?: number;
}

export interface RemotePluginSpec {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /**
   * Plugin name the child must announce in `hello`; a mismatch fails the
   * load. Lets the manifest refer to the plugin by name before it runs.
   */
  name?: string;
  /**
   * Environment of the child. The bot's own environment is never inherited
   * (it holds platform secrets); only `PATH`, the variables named in
   * `inheritEnv` and these entries are passed, later ones winning.
   */
  env?: Readonly<Record<string, string>>;
  /** Names of host environment variables to copy, e.g. `HTTPS_PROXY`, `HOME`. */
  inheritEnv?: readonly string[];
  /** Run time of one scheduled `task.run`. Default 60s. */
  taskTimeoutMs?: number;
  /** Which delivered messages a child may still reply to. */
  replyWindow?: ReplyWindowOptions;
  /** Wait for the child's `hello`. Default 10s. */
  handshakeTimeoutMs?: number;
  /** Wait for the child's answer to `initialize`. Default 30s. */
  initializeTimeoutMs?: number;
  /** Run time of one `command.execute`. Default 30s. */
  commandTimeoutMs?: number;
  /** Time a child gets to exit after `shutdown` before SIGKILL. Default 3s. */
  shutdownGraceMs?: number;
  restart?: RemotePluginRestartPolicy;
}

export type RemotePluginState =
  | "starting"
  | "ready"
  | "restarting"
  | "failed"
  | "closed";

export interface RemotePluginStatus {
  state: RemotePluginState;
  pid: number | undefined;
  restarts: number;
}

export interface RemoteBotPlugin extends BotPlugin {
  /** Kills the child. Safe to call repeatedly, and when `setup` never ran. */
  close(): Promise<void>;
  status(): RemotePluginStatus;
}

interface Hello {
  protocol: number;
  name: string;
  version: string;
  apiVersion: number;
  description?: string;
  help?: PluginHelpDefinition;
  permissions: PluginPermission[];
  requires: string[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Rejections are consumed by whoever awaits; never an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const MAX_CANCELLED_INVOCATIONS = 256;
const MAX_SENT_MESSAGES = 1024;
const MAX_METRICS = 64;
const MAX_STDERR_LINE = 2000;
const SCOPES: readonly string[] = ["group", "direct", "guild"];
const ROLES: readonly string[] = ["member", "admin", "owner"];

/** One running child process and its JSON-RPC peer. */
class Session {
  public readonly peer: JsonRpcPeer;
  public readonly hello = defer<Hello>();
  public readonly exited = defer<void>();
  public exitedAlready = false;
  public initialized = false;
  public helloSeen = false;
  private stderrBuffer = "";

  public constructor(
    public readonly child: ChildProcess,
    private readonly owner: RemotePluginHost
  ) {
    this.peer = new JsonRpcPeer({
      write: (line) => {
        if (child.stdin?.writable) {
          child.stdin.write(`${line}\n`);
        }
      },
      handleRequest: (method, params) =>
        owner.handleRequest(this, method, params),
      handleNotification: (method, params) =>
        owner.handleNotification(this, method, params),
      onInvalidLine: (line) => owner.onStrayOutput(line),
      onOverflow: () => {
        owner.logger.error({}, "remote plugin sent an oversized line; killing");
        child.kill("SIGKILL");
      }
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.peer.receive(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.onStderr(chunk));
    child.stdin?.on("error", () => undefined);
    child.on("error", (error) => {
      this.hello.reject(error);
      this.finish(`failed to start: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.finish(
        `exited (code ${code ?? "null"}, signal ${signal ?? "null"})`
      );
    });
  }

  private finish(reason: string): void {
    if (this.exitedAlready) {
      return;
    }
    this.exitedAlready = true;
    this.peer.close(`remote plugin ${reason}`);
    this.hello.reject(new Error(`remote plugin ${reason} before hello`));
    this.exited.resolve();
    this.owner.onExit(this, reason);
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let newline = this.stderrBuffer.indexOf("\n");
    while (newline !== -1) {
      this.owner.onStderrLine(this.stderrBuffer.slice(0, newline));
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      newline = this.stderrBuffer.indexOf("\n");
    }
    if (this.stderrBuffer.length > MAX_STDERR_LINE) {
      this.owner.onStderrLine(this.stderrBuffer);
      this.stderrBuffer = "";
    }
  }
}

class RemotePluginHost {
  public logger: Logger;
  public state: RemotePluginState = "starting";
  private session: Session | undefined;
  private ctx: PluginContext | undefined;
  private identity: Hello | undefined;
  private registrations: Dispose[] = [];
  private restarts = 0;
  private consecutiveCrashes = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private stableTimer: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;
  private readonly known: ReplyWindow;
  private invocationCounter = 0;
  /** Invocations that timed out; late replies for them are refused. */
  private readonly cancelled = new Set<string>();
  private readonly tasks = new Map<string, Dispose>();
  private readonly oneShots = new Set<string>();
  private readonly sent = new Set<string>();
  private readonly settingsHandles = new Map<
    string,
    ScopedSettings<Record<string, unknown>>
  >();
  private readonly metricHandles = new Map<
    string,
    { kind: string; handle: Counter | Gauge | Histogram }
  >();
  private restartCounter: Counter | undefined;
  private upGauge: Gauge | undefined;

  public constructor(
    private readonly spec: RemotePluginSpec,
    logger: Logger,
    private readonly environment: NodeJS.ProcessEnv
  ) {
    this.logger = logger;
    this.known = new ReplyWindow(spec.replyWindow);
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }

  public pid(): number | undefined {
    return this.session?.child.pid;
  }

  public status(): RemotePluginStatus {
    return { state: this.state, pid: this.pid(), restarts: this.restarts };
  }

  // ---- lifecycle ---------------------------------------------------------

  public async connect(): Promise<Hello> {
    const session = this.spawnSession();
    try {
      const hello = await this.awaitHello(session);
      if (this.spec.name !== undefined && hello.name !== this.spec.name) {
        throw new Error(
          `remote plugin announced name "${hello.name}", but the manifest expects "${this.spec.name}"`
        );
      }
      this.identity = hello;
      return hello;
    } catch (error) {
      this.state = "closed";
      await this.killSession(session);
      throw error;
    }
  }

  public async setup(ctx: PluginContext): Promise<Dispose> {
    this.ctx = ctx;
    this.restartCounter = ctx.metrics.counter(
      "restarts_total",
      "Times the remote plugin process was restarted after a crash."
    );
    this.upGauge = ctx.metrics.gauge(
      "up",
      "1 while the remote plugin process is running and initialised."
    );
    const session = this.session;
    if (!session || this.state === "closed") {
      throw new Error(`remote plugin "${ctx.pluginName}" is not connected`);
    }
    try {
      await this.initialize(session);
    } catch (error) {
      await this.close();
      throw error;
    }
    return () => this.close();
  }

  public close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.state = "closed";
    this.upGauge?.set(0);
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    await this.disposeRegistrations();
    const session = this.session;
    this.session = undefined;
    if (session) {
      await this.killSession(session);
    }
  }

  private spawnSession(): Session {
    const spec = this.spec;
    const child = spawn(spec.command, [...(spec.args ?? [])], {
      cwd: spec.cwd,
      env: this.childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
    const session = new Session(child, this);
    this.session = session;
    return session;
  }

  private childEnvironment(): Record<string, string> {
    const env: Record<string, string> = { PATH: this.environment.PATH ?? "" };
    for (const name of this.spec.inheritEnv ?? []) {
      const value = this.environment[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    return { ...env, ...this.spec.env };
  }

  private async awaitHello(session: Session): Promise<Hello> {
    const timeoutMs = this.spec.handshakeTimeoutMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new RpcError(
              RPC_CODES.timeout,
              `remote plugin sent no hello within ${timeoutMs}ms`
            )
          ),
        timeoutMs
      );
    });
    try {
      return await Promise.race([session.hello.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async initialize(session: Session): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) {
      throw new Error("remote plugin has no context");
    }
    this.registrations = [];
    this.state = "starting";
    try {
      await session.peer.request(
        "initialize",
        {
          protocol: this.identity?.protocol ?? 1,
          pluginName: ctx.pluginName,
          config: ctx.config,
          grantedPermissions: this.identity?.permissions ?? []
        },
        this.spec.initializeTimeoutMs ?? 30_000
      );
    } catch (error) {
      await this.disposeRegistrations();
      throw error;
    }
    if (this.session !== session || session.exitedAlready) {
      await this.disposeRegistrations();
      throw new Error("remote plugin exited during initialisation");
    }
    session.initialized = true;
    this.state = "ready";
    this.upGauge?.set(1);
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.consecutiveCrashes = 0;
    }, this.spec.restart?.stableAfterMs ?? 30_000);
    this.stableTimer.unref();
  }

  private async killSession(session: Session): Promise<void> {
    if (!session.exitedAlready) {
      const grace = this.spec.shutdownGraceMs ?? 3000;
      try {
        await session.peer.request("shutdown", {}, grace);
      } catch {
        // The child is unresponsive or already gone; fall through to the kill.
      }
      const exitedInTime = await Promise.race([
        session.exited.promise.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), grace);
          timer.unref();
        })
      ]);
      if (!exitedInTime) {
        session.child.kill("SIGKILL");
        await session.exited.promise;
      }
    }
    session.peer.close("remote plugin closed");
  }

  /** Called by a `Session` when its process is gone. */
  public onExit(session: Session, reason: string): void {
    if (this.session !== session || this.state === "closed") {
      return;
    }
    if (!session.initialized) {
      // Died during the initial load or a restart attempt; those paths see it
      // through their own rejected request.
      return;
    }
    this.logger.error({ reason }, "remote plugin process is gone");
    this.upGauge?.set(0);
    void this.handleCrash();
  }

  private async handleCrash(): Promise<void> {
    clearTimeout(this.stableTimer);
    await this.disposeRegistrations();
    this.session = undefined;
    const policy = this.spec.restart ?? {};
    this.consecutiveCrashes += 1;
    if (this.consecutiveCrashes > (policy.maxRestarts ?? 5)) {
      this.state = "failed";
      this.logger.error(
        { crashes: this.consecutiveCrashes },
        "remote plugin crashed too often; leaving it stopped"
      );
      return;
    }
    this.state = "restarting";
    const delay = Math.min(
      policy.maxDelayMs ?? 30_000,
      (policy.baseDelayMs ?? 500) * 2 ** (this.consecutiveCrashes - 1)
    );
    this.logger.warn({ delayMs: delay }, "restarting remote plugin");
    this.restartTimer = setTimeout(() => void this.restart(), delay);
  }

  private async restart(): Promise<void> {
    if (this.state !== "restarting") {
      return;
    }
    const session = this.spawnSession();
    try {
      const hello = await this.awaitHello(session);
      this.assertSameIdentity(hello);
      this.restarts += 1;
      this.restartCounter?.inc();
      await this.initialize(session);
      this.logger.info({}, "remote plugin restarted");
    } catch (error) {
      this.logger.error(
        { error },
        `remote plugin restart failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.session = undefined;
      await this.killSession(session);
      if (!this.isClosed()) {
        void this.handleCrash();
      }
    }
  }

  private assertSameIdentity(hello: Hello): void {
    const before = this.identity;
    if (!before) {
      throw new Error("restarted remote plugin has no recorded identity");
    }
    const list = (values: readonly string[]) =>
      `[${[...values].sort().join(",")}]`;
    const fields: [string, string, string][] = [
      ["name", before.name, hello.name],
      ["version", before.version, hello.version],
      ["apiVersion", String(before.apiVersion), String(hello.apiVersion)],
      ["protocol", String(before.protocol), String(hello.protocol)],
      ["permissions", list(before.permissions), list(hello.permissions)],
      ["requires", list(before.requires), list(hello.requires)]
    ];
    const changed = fields
      .filter(([, was, now]) => was !== now)
      .map(([field, was, now]) => `${field}: ${was} -> ${now}`);
    if (changed.length > 0) {
      throw new Error(
        `restarted remote plugin changed its identity (${changed.join("; ")})`
      );
    }
  }

  private async disposeRegistrations(): Promise<void> {
    const registrations = this.registrations;
    this.registrations = [];
    this.tasks.clear();
    for (const dispose of registrations.reverse()) {
      try {
        await dispose();
      } catch (error) {
        this.logger.warn({ error }, "failed to dispose remote registration");
      }
    }
  }

  public onStderrLine(line: string): void {
    if (line.trim().length > 0) {
      this.logger.info({ stream: "stderr" }, line.slice(0, MAX_STDERR_LINE));
    }
  }

  public onStrayOutput(line: string): void {
    this.logger.warn(
      { stream: "stdout" },
      `non-protocol output: ${line.slice(0, MAX_STDERR_LINE)}`
    );
  }

  // ---- child -> host ------------------------------------------------------

  public handleNotification(
    session: Session,
    method: string,
    params: unknown
  ): void {
    if (session !== this.session || method !== "log") {
      return;
    }
    const record = asRecord(params);
    const level = ["debug", "info", "warn", "error"].includes(
      String(record.level)
    )
      ? (record.level as "debug" | "info" | "warn" | "error")
      : "info";
    this.logger[level](
      record.data ?? {},
      typeof record.message === "string" ? record.message : ""
    );
  }

  public async handleRequest(
    session: Session,
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (method === "hello") {
      return this.handleHello(session, params);
    }
    const ctx = this.ctx;
    if (session !== this.session || !ctx || this.state === "closed") {
      throw new RpcError(RPC_CODES.unavailable, "plugin is not initialised");
    }
    try {
      return await this.dispatch(ctx, method, asRecord(params));
    } catch (error) {
      if (error instanceof PermissionError) {
        throw new RpcError(RPC_CODES.permissionDenied, error.message, {
          permission: error.permission
        });
      }
      throw error;
    }
  }

  private handleHello(session: Session, params: unknown): unknown {
    if (session.helloSeen) {
      throw new RpcError(RPC_CODES.invalidRequest, "hello was already sent");
    }
    session.helloSeen = true;
    try {
      const hello = parseHello(params);
      session.hello.resolve(hello);
      return { protocol: hello.protocol, host: "qq-bot" };
    } catch (error) {
      const failure = new RpcError(
        RPC_CODES.invalidParams,
        error instanceof Error ? error.message : String(error)
      );
      session.hello.reject(failure);
      throw failure;
    }
  }

  private async dispatch(
    ctx: PluginContext,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    switch (method) {
      case "commands.register":
        this.registrations.push(
          ctx.commands.register(this.buildCommand(params))
        );
        return null;
      case "events.subscribe": {
        const event = requireString(params, "event");
        this.registrations.push(
          ctx.events.on(event as "message.created", (payload) => {
            if (event === "message.created") {
              this.known.remember(payload as IncomingMessage);
            }
            this.session?.peer.notify("event", {
              event,
              payload: toWire(payload)
            });
          })
        );
        return null;
      }
      case "events.emit":
        await ctx.events.emit(
          requireString(params, "event") as "message.created",
          asRecord(params.payload) as never
        );
        return null;
      case "messages.send":
        this.assertNotCancelled(params);
        return toWire(await this.send(ctx, asRecord(params.message)));
      case "messages.reply": {
        this.assertNotCancelled(params);
        const message = this.known.get(requireString(params, "messageId"));
        if (!message) {
          throw invalid("messageId is not a message this plugin received");
        }
        return toWire(
          this.noteSent(
            await ctx.messages.reply(message, parseContent(params.content))
          )
        );
      }
      case "messages.recall": {
        const id = requireString(params, "id");
        if (!this.sent.has(id)) {
          throw invalid("id is not a message this plugin sent");
        }
        const sent = asRecord(params.message);
        await ctx.messages.recall({
          platform: requireString(sent, "platform"),
          scope: parseScope(sent.scope),
          conversationId: requireString(sent, "conversationId"),
          id,
          timestamp: new Date()
        });
        return null;
      }
      case "store.get":
        return (await ctx.store.get(requireString(params, "key"))) ?? null;
      case "store.set":
        await ctx.store.set(
          requireString(params, "key"),
          params.value,
          typeof params.ttlMs === "number" ? { ttlMs: params.ttlMs } : undefined
        );
        return null;
      case "store.compareAndSet": {
        this.requireMinor("store.compareAndSet");
        const expected = JSON.stringify(canonical(params.expected ?? null));
        const next = params.value ?? null;
        let swapped = false;
        const current = await ctx.store.update<unknown>(
          requireString(params, "key"),
          (existing) => {
            swapped = JSON.stringify(canonical(existing ?? null)) === expected;
            return swapped ? (next === null ? undefined : next) : existing;
          }
        );
        return { swapped, current: current ?? null };
      }
      case "scheduler.every": {
        const name = requireString(params, "name");
        const intervalMs = requireNumber(params, "intervalMs");
        if (intervalMs <= 0) {
          throw invalid("intervalMs must be positive");
        }
        return this.addTask(name, false, () =>
          ctx.scheduler.every(name, intervalMs, this.taskRunner(name), {
            ...(params.runImmediately === true ? { runImmediately: true } : {}),
            ...parseOverlap(params)
          })
        );
      }
      case "scheduler.cron": {
        const name = requireString(params, "name");
        const expression = requireString(params, "expression");
        const timezone = params.timezone;
        if (
          timezone !== undefined &&
          timezone !== "local" &&
          timezone !== "utc"
        ) {
          throw invalid("timezone must be local or utc");
        }
        return this.addTask(name, false, () =>
          ctx.scheduler.cron(name, expression, this.taskRunner(name), {
            ...(timezone ? { timezone } : {}),
            ...(params.catchUp === true ? { catchUp: true } : {}),
            ...parseOverlap(params)
          })
        );
      }
      case "scheduler.at": {
        const name = requireString(params, "name");
        const when = new Date(requireString(params, "when"));
        if (Number.isNaN(when.getTime())) {
          throw invalid("when must be an ISO date");
        }
        return this.addTask(name, true, () =>
          ctx.scheduler.at(name, when, this.taskRunner(name))
        );
      }
      case "scheduler.cancel": {
        const name = requireString(params, "name");
        const dispose = this.tasks.get(name);
        this.tasks.delete(name);
        await dispose?.();
        return dispose !== undefined;
      }
      case "store.delete":
        return ctx.store.delete(requireString(params, "key"));
      case "store.list": {
        if (!ctx.store.list) {
          throw new RpcError(
            RPC_CODES.unsupported,
            "this host's store cannot list keys"
          );
        }
        return ctx.store.list(requireString(params, "prefix"), {
          limit: typeof params.limit === "number" ? params.limit : undefined,
          after: typeof params.after === "string" ? params.after : undefined
        });
      }
      case "settings.define":
        return this.defineSettings(ctx, params);
      case "settings.get": {
        const target = asRecord(params.target);
        return this.settingsFor(params).get({
          platform: requireString(target, "platform"),
          scope: parseScope(target.scope),
          conversationId: requireString(target, "conversationId")
        });
      }
      case "settings.set":
        return this.settingsFor(params).set(
          parseSettingsScope(params.scope),
          asRecord(params.overrides)
        );
      case "settings.reset":
        return this.settingsFor(params).reset(parseSettingsScope(params.scope));
      case "metrics.counter.inc":
        (this.metric(ctx, "counter", params) as Counter).inc(
          parseLabels(params.labels),
          typeof params.value === "number" ? params.value : undefined
        );
        return null;
      case "metrics.gauge.set":
        (this.metric(ctx, "gauge", params) as Gauge).set(
          requireNumber(params, "value"),
          parseLabels(params.labels)
        );
        return null;
      case "metrics.gauge.add":
        (this.metric(ctx, "gauge", params) as Gauge).add(
          requireNumber(params, "value"),
          parseLabels(params.labels)
        );
        return null;
      case "metrics.histogram.observe":
        (this.metric(ctx, "histogram", params) as Histogram).observe(
          requireNumber(params, "value"),
          parseLabels(params.labels)
        );
        return null;
      default:
        throw new RpcError(
          RPC_CODES.methodNotFound,
          `unknown method "${method}"`
        );
    }
  }

  private buildCommand(wire: Record<string, unknown>): CommandDefinition {
    const subcommands = Array.isArray(wire.subcommands)
      ? wire.subcommands.map((entry) => {
          const sub = asRecord(entry);
          return {
            ...this.commandBase(sub),
            name: requireString(sub, "name"),
            execute: (command) =>
              this.executeRemote(command, requireString(sub, "name"))
          } satisfies SubcommandDefinition;
        })
      : [];
    const hasFallback = wire.fallback === true || subcommands.length === 0;
    return {
      ...this.commandBase(wire),
      name: requireString(wire, "name"),
      ...(subcommands.length > 0 ? { subcommands } : {}),
      ...(hasFallback
        ? { execute: (command) => this.executeRemote(command) }
        : {})
    };
  }

  private commandBase(wire: Record<string, unknown>) {
    const aliases = optionalStrings(wire.aliases);
    const scopes = optionalStrings(wire.scopes)?.map((scope) =>
      parseScope(scope)
    );
    const permission = wire.permission;
    if (
      permission !== undefined &&
      !(typeof permission === "string" && ROLES.includes(permission))
    ) {
      throw invalid("permission must be member, admin or owner");
    }
    if (wire.args !== undefined) {
      this.requireMinor("command args");
    }
    const args =
      wire.args === undefined ? undefined : defineArgsFromWire(wire.args);
    return {
      description: requireString(wire, "description"),
      ...(args ? { args } : {}),
      ...(aliases ? { aliases } : {}),
      ...(permission ? { permission: permission as "member" } : {}),
      ...(typeof wire.usage === "string" ? { usage: wire.usage } : {}),
      ...(typeof wire.hidden === "boolean" ? { hidden: wire.hidden } : {}),
      ...(typeof wire.cooldownMs === "number"
        ? { cooldownMs: wire.cooldownMs }
        : {}),
      ...(scopes ? { scopes } : {}),
      ...(Array.isArray(wire.examples)
        ? {
            examples: wire.examples.map((example) => {
              const record = asRecord(example);
              return {
                ...(typeof record.args === "string"
                  ? { args: record.args }
                  : {}),
                ...(typeof record.description === "string"
                  ? { description: record.description }
                  : {})
              };
            })
          }
        : {})
    };
  }

  private async executeRemote(
    command: {
      message: IncomingMessage;
      command: string;
      subcommand?: string | undefined;
      args: string[];
      rawArgs: string;
      parsed: unknown;
      reply(content: MessageContent): Promise<SentMessage>;
    },
    subcommand?: string
  ): Promise<void> {
    const session = this.session;
    if (!session || this.state !== "ready") {
      throw new RpcError(RPC_CODES.unavailable, "remote plugin is not running");
    }
    this.known.remember(command.message);
    this.invocationCounter += 1;
    const invocationId = `c${this.invocationCounter}`;
    let result: unknown;
    try {
      result = await session.peer.request(
        "command.execute",
        {
          ...(this.supportsMinor() ? { invocationId } : {}),
          command: command.command,
          ...(subcommand ? { subcommand } : {}),
          args: command.args,
          rawArgs: command.rawArgs,
          ...(command.parsed !== undefined ? { parsed: command.parsed } : {}),
          message: toWire(command.message)
        },
        this.spec.commandTimeoutMs ?? 30_000
      );
    } catch (error) {
      if (error instanceof RpcError && error.code === RPC_CODES.timeout) {
        this.markCancelled(invocationId);
        if (this.supportsMinor()) {
          session.peer.notify("command.cancel", { invocationId });
        }
      }
      throw error;
    }
    const reply = asRecord(result).reply;
    if (reply !== undefined && reply !== null) {
      this.noteSent(await command.reply(parseContent(reply)));
    }
  }

  private async send(
    ctx: PluginContext,
    wire: Record<string, unknown>
  ): Promise<SentMessage> {
    const delivery = asRecord(wire.delivery);
    const conversationId = requireString(wire, "conversationId");
    const scope = parseScope(wire.scope);
    let parsedDelivery: OutgoingMessage["delivery"];
    if (delivery.type === "passive") {
      const target = asRecord(delivery.target);
      const origin = this.known.get(requireString(target, "messageId"));
      if (
        target.type !== "message" ||
        !origin ||
        origin.conversationId !== conversationId ||
        origin.scope !== scope
      ) {
        throw invalid(
          "a passive send must target a message this plugin received in the same conversation"
        );
      }
      parsedDelivery = {
        type: "passive",
        target: { type: "message", messageId: origin.id }
      };
    } else if (delivery.type === "active") {
      parsedDelivery = {
        type: "active",
        idempotencyKey: requireString(delivery, "idempotencyKey")
      };
    } else if (delivery.type === "platform") {
      parsedDelivery = {
        type: "platform",
        platform: requireString(delivery, "platform"),
        mode: requireString(delivery, "mode"),
        idempotencyKey: requireString(delivery, "idempotencyKey")
      };
    } else {
      throw invalid("delivery.type must be passive, active or platform");
    }
    const reference = wire.reference
      ? { messageId: requireString(asRecord(wire.reference), "messageId") }
      : undefined;
    return this.noteSent(
      await ctx.messages.send({
        conversationId,
        scope,
        content: parseContent(wire.content),
        delivery: parsedDelivery,
        ...(reference ? { reference } : {})
      })
    );
  }

  private defineSettings(
    ctx: PluginContext,
    params: Record<string, unknown>
  ): unknown {
    const key = requireString(params, "key");
    if (!this.settingsHandles.has(key)) {
      this.settingsHandles.set(
        key,
        ctx.settings.define({ key, defaults: asRecord(params.defaults) })
      );
    }
    return { key };
  }

  private settingsFor(
    params: Record<string, unknown>
  ): ScopedSettings<Record<string, unknown>> {
    const handle = this.settingsHandles.get(requireString(params, "key"));
    if (!handle) {
      throw invalid("settings key was not defined with settings.define");
    }
    return handle;
  }

  private metric(
    ctx: PluginContext,
    kind: "counter" | "gauge" | "histogram",
    params: Record<string, unknown>
  ): Counter | Gauge | Histogram {
    const name = requireString(params, "name");
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
      throw invalid("metric name must match [a-z][a-z0-9_]*");
    }
    const existing = this.metricHandles.get(name);
    if (existing) {
      if (existing.kind !== kind) {
        throw invalid(`metric "${name}" is a ${existing.kind}`);
      }
      return existing.handle;
    }
    if (this.metricHandles.size >= MAX_METRICS) {
      throw invalid(
        `a remote plugin may define at most ${MAX_METRICS} metrics`
      );
    }
    const help = requireString(params, "help");
    const labels = optionalStrings(params.labelNames);
    const options = labels ? { labels } : {};
    const buckets = Array.isArray(params.buckets)
      ? params.buckets.filter((value) => typeof value === "number")
      : undefined;
    const handle =
      kind === "counter"
        ? ctx.metrics.counter(name, help, options)
        : kind === "gauge"
          ? ctx.metrics.gauge(name, help, options)
          : ctx.metrics.histogram(name, help, {
              ...options,
              ...(buckets ? { buckets } : {})
            });
    this.metricHandles.set(name, { kind, handle });
    return handle;
  }

  private supportsMinor(): boolean {
    return (this.identity?.protocol ?? 1) >= 1.1;
  }

  /** Guards calls that only exist from protocol 1.1 on. */
  private requireMinor<T = true>(feature: string, value?: T): T {
    if (!this.supportsMinor()) {
      throw new RpcError(
        RPC_CODES.unsupported,
        `${feature} needs protocol 1.1; the plugin announced protocol 1`
      );
    }
    return (value ?? true) as T;
  }

  private markCancelled(invocationId: string): void {
    this.cancelled.add(invocationId);
    if (this.cancelled.size > MAX_CANCELLED_INVOCATIONS) {
      const [oldest] = this.cancelled;
      if (oldest !== undefined) {
        this.cancelled.delete(oldest);
      }
    }
  }

  private assertNotCancelled(params: Record<string, unknown>): void {
    const invocationId = params.invocationId;
    if (typeof invocationId === "string" && this.cancelled.has(invocationId)) {
      throw new RpcError(
        RPC_CODES.cancelled,
        "the command timed out and was cancelled; its replies are refused"
      );
    }
  }

  private addTask(name: string, oneShot: boolean, create: () => Dispose): null {
    this.requireMinor("scheduler");
    if (this.tasks.has(name)) {
      throw invalid(`task "${name}" is already scheduled`);
    }
    const dispose = create();
    this.tasks.set(name, dispose);
    if (oneShot) {
      // A one-shot task frees its name once it has run.
      this.oneShots.add(name);
    }
    this.registrations.push(dispose);
    return null;
  }

  private taskRunner(name: string): (signal: AbortSignal) => Promise<void> {
    return async (signal) => {
      const session = this.session;
      if (!session || this.state !== "ready") {
        throw new RpcError(
          RPC_CODES.unavailable,
          "remote plugin is not running"
        );
      }
      const cancel = () => session.peer.notify("task.cancel", { name });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await session.peer.request(
          "task.run",
          { name },
          this.spec.taskTimeoutMs ?? 60_000
        );
      } catch (error) {
        if (error instanceof RpcError && error.code === RPC_CODES.timeout) {
          cancel();
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
        if (this.oneShots.delete(name)) {
          this.tasks.delete(name);
        }
      }
    };
  }

  private noteSent(message: SentMessage): SentMessage {
    this.sent.add(message.id);
    if (this.sent.size > MAX_SENT_MESSAGES) {
      const oldest = this.sent.values().next().value;
      if (oldest !== undefined) {
        this.sent.delete(oldest);
      }
    }
    return message;
  }
}

// ---- validation helpers -----------------------------------------------------

function invalid(message: string): RpcError {
  return new RpcError(RPC_CODES.invalidParams, message);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (value === undefined || value === null) {
    return {};
  }
  throw invalid("expected an object");
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`"${key}" must be a non-empty string`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`"${key}" must be a finite number`);
  }
  return value;
}

function optionalStrings(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalid("expected an array of strings");
  }
  return value as string[];
}

function parseScope(value: unknown): ChatScope {
  if (typeof value !== "string" || !SCOPES.includes(value)) {
    throw invalid("scope must be group, direct or guild");
  }
  return value as ChatScope;
}

function parseSettingsScope(value: unknown): SettingsScope {
  const record = asRecord(value);
  switch (record.level) {
    case "global":
      return { level: "global" };
    case "platform":
      return { level: "platform", platform: requireString(record, "platform") };
    case "chat":
      return {
        level: "chat",
        platform: requireString(record, "platform"),
        scope: parseScope(record.scope)
      };
    case "conversation":
      return {
        level: "conversation",
        platform: requireString(record, "platform"),
        scope: parseScope(record.scope),
        conversationId: requireString(record, "conversationId")
      };
    default:
      throw invalid("settings scope level is invalid");
  }
}

function parseLabels(
  value: unknown
): Record<string, string | number | boolean> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value);
  for (const label of Object.values(record)) {
    if (!["string", "number", "boolean"].includes(typeof label)) {
      throw invalid("label values must be strings, numbers or booleans");
    }
  }
  return record as Record<string, string | number | boolean>;
}

/**
 * Message content a child may send: text, markdown, keyboards and media by
 * URL. Inline bytes and streams cannot cross the protocol.
 */
function parseContent(value: unknown): MessageContent {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  const media = Array.isArray(record.media)
    ? record.media.map((entry) => {
        const item = asRecord(entry);
        const source = asRecord(item.source);
        if (source.type !== "url") {
          throw new RpcError(
            RPC_CODES.unsupported,
            "remote plugins can only send media by url"
          );
        }
        return {
          type: item.type as "image",
          source: { type: "url" as const, url: requireString(source, "url") },
          ...(typeof item.filename === "string"
            ? { filename: item.filename }
            : {}),
          ...(typeof item.contentType === "string"
            ? { contentType: item.contentType }
            : {})
        };
      })
    : undefined;
  return {
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    ...(typeof record.markdown === "string"
      ? { markdown: record.markdown }
      : {}),
    ...(record.keyboard !== undefined
      ? { keyboard: asRecord(record.keyboard) as never }
      : {}),
    ...(media && media.length > 0 ? { media: media as never } : {})
  };
}

function parseHello(params: unknown): Hello {
  const record = asRecord(params);
  const protocol = record.protocol;
  if (
    typeof protocol !== "number" ||
    !SUPPORTED_REMOTE_PROTOCOLS.includes(protocol)
  ) {
    throw invalid(
      `unsupported protocol ${String(protocol)}; this host speaks ${SUPPORTED_REMOTE_PROTOCOLS.join(", ")}`
    );
  }
  const name = requireString(record, "name");
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    throw invalid("name must match [a-z0-9][a-z0-9._-]*");
  }
  const version = requireString(record, "version");
  assertPluginVersion(version, `remote plugin "${name}" version`);
  const apiVersion = record.apiVersion ?? 2;
  if (
    typeof apiVersion !== "number" ||
    !(SUPPORTED_PLUGIN_API_VERSIONS as readonly number[]).includes(apiVersion)
  ) {
    throw invalid(`unsupported plugin API version ${String(apiVersion)}`);
  }
  const permissions = (optionalStrings(record.permissions) ??
    []) as PluginPermission[];
  for (const permission of permissions) {
    if (
      !(REMOTE_PERMISSIONS as readonly string[]).includes(permission) ||
      (permission === "scheduler" && protocol < 1.1)
    ) {
      throw invalid(
        `permission "${permission}" is not available to remote plugins`
      );
    }
  }
  const help = record.help === undefined ? undefined : asRecord(record.help);
  return {
    protocol,
    name,
    version,
    apiVersion,
    permissions,
    requires: optionalStrings(record.requires) ?? [],
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    ...(help ? { help: help as PluginHelpDefinition } : {})
  };
}

/** Recursively sorts object keys so equal values stringify equally. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  }
  return value;
}

function parseOverlap(params: Record<string, unknown>): {
  overlap?: "skip" | "allow";
} {
  const overlap = params.overlap;
  if (overlap === undefined) {
    return {};
  }
  if (overlap !== "skip" && overlap !== "allow") {
    throw invalid("overlap must be skip or allow");
  }
  return { overlap };
}

/** Declarative `defineArgs` spec as JSON; validated before it is trusted. */
function defineArgsFromWire(value: unknown) {
  const wire = asRecord(value);
  const spec: Record<string, ArgDefinition> = {};
  for (const [name, entry] of Object.entries(wire)) {
    if (!/^[a-z][A-Za-z0-9]*$/u.test(name)) {
      throw invalid(`argument name "${name}" must match [a-z][A-Za-z0-9]*`);
    }
    const definition = asRecord(entry);
    const base = {
      ...(typeof definition.description === "string"
        ? { description: definition.description }
        : {}),
      ...(definition.optional === true ? { optional: true as const } : {})
    };
    switch (definition.type) {
      case "string": {
        const choices = optionalStrings(definition.choices);
        spec[name] = {
          type: "string",
          ...base,
          ...(choices ? { choices } : {}),
          ...(definition.rest === true ? { rest: true } : {})
        };
        break;
      }
      case "number":
      case "integer":
        spec[name] = {
          type: definition.type,
          ...base,
          ...(typeof definition.min === "number"
            ? { min: definition.min }
            : {}),
          ...(typeof definition.max === "number" ? { max: definition.max } : {})
        };
        break;
      case "boolean":
        spec[name] = { type: "boolean", ...base };
        break;
      default:
        throw invalid(
          `argument "${name}" needs a type of string, number, integer or boolean`
        );
    }
  }
  try {
    return defineArgs(spec as ArgSpec);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

/** JSON-safe copy of a payload; drops adapter `raw` data. */
function toWire(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null, (key, entry: unknown) =>
      key === "raw" ? undefined : entry
    )
  );
}

/**
 * Starts the child, performs the handshake and returns it as a `BotPlugin`.
 *
 * The child is already running when this resolves, so a caller that decides
 * not to load the plugin must call `close()`. Unloading the plugin from the
 * kernel kills the child by itself.
 */
export async function connectRemotePlugin(
  spec: RemotePluginSpec,
  options: { logger: Logger; environment?: NodeJS.ProcessEnv }
): Promise<RemoteBotPlugin> {
  const host = new RemotePluginHost(
    spec,
    options.logger,
    options.environment ?? process.env
  );
  const hello = await host.connect();
  const logger = options.logger.child({ remotePlugin: hello.name });
  host.logger = logger;
  return {
    name: hello.name,
    version: hello.version,
    apiVersion: hello.apiVersion,
    // Always restricted: a remote plugin never gets the legacy unrestricted
    // model, even when it declares no permissions.
    permissions: hello.permissions,
    requires: hello.requires,
    ...(hello.description ? { description: hello.description } : {}),
    ...(hello.help ? { help: hello.help } : {}),
    setup: (context) => host.setup(context as PluginContext),
    close: () => host.close(),
    status: () => host.status()
  };
}
