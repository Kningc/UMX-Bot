import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BotKernelHealth } from "@umx-bot/core";
import type { Logger } from "@umx-bot/plugin-sdk";

export type OpsReadiness = "starting" | "ready" | "unhealthy" | "stopping";

export interface OpsServerOptions {
  host: string;
  port: number;
  logger: Logger;
  getHealth: () => BotKernelHealth;
  /** Last result of the adapter's business health probe. */
  getReadiness: () => { status: OpsReadiness; updatedAt: Date | undefined };
  /** How stale a readiness probe may be before `/readyz` fails. */
  readinessMaxAgeMs: number;
  /** Extra Prometheus text appended to `/metrics` (kernel and plugin metrics). */
  getExtraMetrics?: () => string;
}

export interface OpsServer {
  /** Resolves with the bound port, which differs from `port` when it was 0. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Small read-only HTTP surface for operations: liveness, readiness and
 * Prometheus metrics.
 *
 * It is unauthenticated, so it defaults to loopback and warns when bound
 * anywhere else. Nothing here mutates bot state.
 */
export function createOpsServer(options: OpsServerOptions): OpsServer {
  const { host, port, logger, getHealth, getReadiness } = options;
  if (!LOOPBACK_HOSTS.has(host)) {
    logger.warn(
      { host },
      "the ops endpoint is unauthenticated; bind it to loopback and put a reverse proxy in front of it if it must be reachable"
    );
  }

  const server: Server = createServer((request, response) => {
    // Only reads are exposed, so anything but GET/HEAD is rejected outright.
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {
        "content-type": "text/plain; charset=utf-8",
        allow: "GET, HEAD"
      });
      response.end("method not allowed\n");
      return;
    }
    const path = (request.url ?? "/").split("?")[0];
    try {
      switch (path) {
        case "/healthz": {
          const health = getHealth();
          const live = health.state === "running";
          sendJson(response, live ? 200 : 503, {
            status: live ? "ok" : health.state,
            state: health.state,
            adapter: health.adapter,
            uptimeMs: health.uptimeMs,
            inFlightMessages: health.inFlightMessages
          });
          return;
        }
        case "/readyz": {
          const health = getHealth();
          const readiness = getReadiness();
          const age =
            readiness.updatedAt === undefined
              ? Number.POSITIVE_INFINITY
              : Date.now() - readiness.updatedAt.getTime();
          const fresh = age <= options.readinessMaxAgeMs;
          const ready =
            health.state === "running" && readiness.status === "ready" && fresh;
          sendJson(response, ready ? 200 : 503, {
            status: ready ? "ok" : "not-ready",
            state: health.state,
            probe: readiness.status,
            probeAgeMs: Number.isFinite(age) ? Math.round(age) : null,
            // Says *why* it is not ready, so an operator is not left guessing.
            reason: ready
              ? undefined
              : health.state !== "running"
                ? `kernel state is ${health.state}`
                : readiness.status !== "ready"
                  ? `last probe was ${readiness.status}`
                  : "last probe is stale"
          });
          return;
        }
        case "/metrics": {
          const body = `${renderPrometheus(getHealth())}${options.getExtraMetrics?.() ?? ""}`;
          response.writeHead(200, {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
            "content-length": Buffer.byteLength(body)
          });
          response.end(request.method === "HEAD" ? undefined : body);
          return;
        }
        default:
          sendJson(response, 404, {
            status: "not-found",
            endpoints: ["/healthz", "/readyz", "/metrics"]
          });
      }
    } catch (error) {
      logger.error({ error, path }, "ops endpoint request failed");
      sendJson(response, 500, { status: "error" });
    }
  });

  // A stuck ops request must never hold the process open on shutdown.
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;

  return {
    listen: () =>
      new Promise<number>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          const address = server.address() as AddressInfo | null;
          const bound = address?.port ?? port;
          logger.info({ host, port: bound }, "ops endpoint listening");
          resolve(bound);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeIdleConnections();
        server.close(() => resolve());
        // close() waits for in-flight requests; the timeouts above bound that.
        setTimeout(() => {
          server.closeAllConnections();
          resolve();
        }, 2_000).unref();
      })
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  response.end(text);
}

export function renderPrometheus(health: BotKernelHealth): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    lines.push(`${name} ${formatNumber(value)}`);
  };
  const counter = (name: string, help: string, value: number): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    lines.push(`${name} ${formatNumber(value)}`);
  };

  gauge(
    "qq_bot_up",
    "1 when the kernel is running, 0 otherwise.",
    health.state === "running" ? 1 : 0
  );
  gauge(
    "qq_bot_uptime_seconds",
    "Seconds since the kernel reached the running state.",
    health.uptimeMs / 1000
  );
  gauge(
    "qq_bot_messages_in_flight",
    "Messages currently being processed.",
    health.inFlightMessages
  );
  gauge(
    "qq_bot_plugins_loaded",
    "Number of loaded plugins.",
    health.plugins.length
  );
  counter(
    "qq_bot_messages_received_total",
    "Messages accepted from the adapter.",
    health.metrics.received
  );
  counter(
    "qq_bot_messages_processed_total",
    "Messages processed without an unhandled error.",
    health.metrics.processed
  );
  counter(
    "qq_bot_messages_failed_total",
    "Messages whose processing threw.",
    health.metrics.failed
  );
  counter(
    "qq_bot_commands_handled_total",
    "Messages routed to a command.",
    health.metrics.commandsHandled
  );

  const latency = health.metrics.processingLatency;
  lines.push(
    "# HELP qq_bot_message_processing_duration_seconds End-to-end message handling latency.",
    "# TYPE qq_bot_message_processing_duration_seconds histogram"
  );
  for (const bucket of latency.buckets) {
    const bound = Number.isFinite(bucket.leMs)
      ? formatNumber(bucket.leMs / 1000)
      : "+Inf";
    lines.push(
      `qq_bot_message_processing_duration_seconds_bucket{le="${bound}"} ${bucket.count}`
    );
  }
  lines.push(
    `qq_bot_message_processing_duration_seconds_sum ${formatNumber(
      latency.totalMs / 1000
    )}`,
    `qq_bot_message_processing_duration_seconds_count ${latency.count}`
  );

  // Adapter diagnostics are adapter-specific, so they are flattened
  // generically: every number and boolean becomes a gauge. That way a new
  // diagnostic field shows up in metrics without touching this file.
  for (const [name, value] of flattenDiagnostics(
    health.adapterDiagnostics ?? {}
  )) {
    gauge(
      `qq_bot_adapter_${name}`,
      `Adapter diagnostic "${name}".`,
      typeof value === "boolean" ? (value ? 1 : 0) : value
    );
  }

  return `${lines.join("\n")}\n`;
}

function flattenDiagnostics(
  source: Readonly<Record<string, unknown>>,
  prefix = ""
): [string, number | boolean][] {
  const result: [string, number | boolean][] = [];
  for (const [key, value] of Object.entries(source)) {
    const name = prefix ? `${prefix}_${sanitize(key)}` : sanitize(key);
    if (typeof value === "number" && Number.isFinite(value)) {
      result.push([name, value]);
    } else if (typeof value === "boolean") {
      result.push([name, value]);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result.push(
        ...flattenDiagnostics(value as Record<string, unknown>, name)
      );
    }
    // Strings, nulls and arrays are deliberately dropped: they are not
    // Prometheus samples and belong in /healthz instead.
  }
  return result;
}

function sanitize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/gu, "_");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6);
}
