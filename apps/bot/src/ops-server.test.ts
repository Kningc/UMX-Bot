import type { BotKernelHealth } from "@qq-bot/core";
import type { Logger } from "@qq-bot/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpsServer,
  type OpsReadiness,
  type OpsServer,
  renderPrometheus
} from "./ops-server.js";

class SilentLogger implements Logger {
  public readonly warnings: unknown[] = [];
  public debug(): void {}
  public info(): void {}
  public warn(data: unknown): void {
    this.warnings.push(data);
  }
  public error(): void {}
  public child(): Logger {
    return this;
  }
}

function createHealth(
  overrides: Partial<BotKernelHealth> = {}
): BotKernelHealth {
  return {
    state: "running",
    adapter: "test",
    startedAt: new Date(Date.now() - 5_000),
    uptimeMs: 5_000,
    inFlightMessages: 1,
    metrics: {
      received: 7,
      processed: 6,
      failed: 1,
      commandsHandled: 4,
      processingLatency: {
        count: 2,
        totalMs: 30,
        maxMs: 25,
        buckets: [
          { leMs: 5, count: 0 },
          { leMs: 10, count: 1 },
          { leMs: 25, count: 2 },
          { leMs: Number.POSITIVE_INFINITY, count: 2 }
        ]
      }
    },
    plugins: [],
    ...overrides
  };
}

const servers: OpsServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function start(options: {
  health?: BotKernelHealth;
  readiness?: { status: OpsReadiness; updatedAt: Date | undefined };
  readinessMaxAgeMs?: number;
  host?: string;
  logger?: Logger;
}): Promise<{ base: string; logger: Logger }> {
  const logger = options.logger ?? new SilentLogger();
  const server = createOpsServer({
    host: options.host ?? "127.0.0.1",
    port: 0,
    logger,
    getHealth: () => options.health ?? createHealth(),
    getReadiness: () =>
      options.readiness ?? { status: "ready", updatedAt: new Date() },
    readinessMaxAgeMs: options.readinessMaxAgeMs ?? 90_000
  });
  servers.push(server);
  const port = await server.listen();
  return { base: `http://127.0.0.1:${port}`, logger };
}

describe("ops server", () => {
  it("reports liveness while the kernel is running", async () => {
    const { base } = await start({});

    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      state: "running",
      adapter: "test"
    });
  });

  it("fails liveness when the kernel is not running", async () => {
    const { base } = await start({
      health: createHealth({ state: "failed" })
    });

    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ state: "failed" });
  });

  it("fails readiness and says why when the probe is unhealthy", async () => {
    const { base } = await start({
      readiness: { status: "unhealthy", updatedAt: new Date() }
    });

    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not-ready",
      reason: "last probe was unhealthy"
    });
  });

  it("fails readiness when the probe is stale", async () => {
    const { base } = await start({
      readiness: {
        status: "ready",
        updatedAt: new Date(Date.now() - 600_000)
      },
      readinessMaxAgeMs: 1_000
    });

    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      reason: "last probe is stale"
    });
  });

  it("fails readiness when no probe has run yet", async () => {
    const { base } = await start({
      readiness: { status: "starting", updatedAt: undefined }
    });

    const response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      probeAgeMs: null
    });
  });

  it("serves Prometheus metrics", async () => {
    const { base } = await start({});

    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("qq_bot_up 1");
    expect(body).toContain("qq_bot_messages_received_total 7");
    expect(body).toContain(
      'qq_bot_message_processing_duration_seconds_bucket{le="+Inf"} 2'
    );
  });

  it("rejects anything other than GET and HEAD", async () => {
    const { base } = await start({});

    const response = await fetch(`${base}/metrics`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("lists its endpoints on an unknown path", async () => {
    const { base } = await start({});

    const response = await fetch(`${base}/nope`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      endpoints: ["/healthz", "/readyz", "/metrics"]
    });
  });

  it("rejects listen() when the port is already taken", async () => {
    const first = await start({});
    const port = Number(new URL(first.base).port);
    const second = createOpsServer({
      host: "127.0.0.1",
      port,
      logger: new SilentLogger(),
      getHealth: createHealth,
      getReadiness: () => ({ status: "ready", updatedAt: new Date() }),
      readinessMaxAgeMs: 1_000
    });

    // main.ts catches this and carries on without the endpoint.
    await expect(second.listen()).rejects.toThrow(/EADDRINUSE/u);
  });

  it("warns when bound outside loopback", async () => {
    const logger = new SilentLogger();
    createOpsServer({
      host: "0.0.0.0",
      port: 0,
      logger,
      getHealth: createHealth,
      getReadiness: () => ({ status: "ready", updatedAt: new Date() }),
      readinessMaxAgeMs: 1_000
    });

    expect(logger.warnings).toHaveLength(1);
  });
});

describe("renderPrometheus", () => {
  it("flattens adapter diagnostics into gauges", () => {
    const body = renderPrometheus(
      createHealth({
        adapterDiagnostics: {
          gateway: {
            ready: true,
            connected: false,
            reconnects: 3,
            processedSequence: null,
            lastMessage: { event: "GROUP_AT_MESSAGE_CREATE" }
          },
          outbox: { unpersisted: 2 },
          deduplication: { size: 12, persisted: true }
        }
      })
    );

    expect(body).toContain("qq_bot_adapter_gateway_ready 1");
    expect(body).toContain("qq_bot_adapter_gateway_connected 0");
    expect(body).toContain("qq_bot_adapter_gateway_reconnects 3");
    expect(body).toContain("qq_bot_adapter_outbox_unpersisted 2");
    expect(body).toContain("qq_bot_adapter_deduplication_size 12");
    expect(body).toContain("qq_bot_adapter_deduplication_persisted 1");
    // Non-numeric diagnostics belong in /healthz, not in metrics.
    expect(body).not.toContain("processed_sequence");
    expect(body).not.toContain("GROUP_AT_MESSAGE_CREATE");
  });

  it("emits a well-formed histogram", () => {
    const body = renderPrometheus(createHealth());
    const buckets = body
      .split("\n")
      .filter((line) => line.includes("_duration_seconds_bucket"));

    expect(buckets).toEqual([
      'qq_bot_message_processing_duration_seconds_bucket{le="0.005000"} 0',
      'qq_bot_message_processing_duration_seconds_bucket{le="0.010000"} 1',
      'qq_bot_message_processing_duration_seconds_bucket{le="0.025000"} 2',
      'qq_bot_message_processing_duration_seconds_bucket{le="+Inf"} 2'
    ]);
    expect(body).toContain(
      "qq_bot_message_processing_duration_seconds_sum 0.030000"
    );
    expect(body).toContain(
      "qq_bot_message_processing_duration_seconds_count 2"
    );
  });
});
