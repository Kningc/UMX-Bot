import type {
  Counter,
  Dispose,
  Gauge,
  Histogram,
  MetricLabels,
  MetricOptions,
  MetricsRegistry as PluginMetricsRegistry
} from "@qq-bot/plugin-sdk";

type MetricType = "counter" | "gauge" | "histogram";

const MAX_SERIES_PER_FAMILY = 1_000;
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
const LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const DEFAULT_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
];

interface HistogramSeries {
  counts: number[];
  sum: number;
  count: number;
}

interface Family {
  type: MetricType;
  help: string;
  labelNames: readonly string[];
  buckets: readonly number[];
  owner: string;
  series: Map<string, { labels: string; value: number | HistogramSeries }>;
}

/**
 * Prometheus registry shared by the kernel and plugins.
 *
 * Plugin metrics are namespaced `qq_bot_plugin_<plugin>_<name>` and removed
 * when the plugin unloads, so a reloaded plugin starts from zero and a stale
 * family never lingers in `/metrics`.
 */
export class MetricsRegistry {
  private readonly families = new Map<string, Family>();

  public forPlugin(
    plugin: string,
    track: (dispose: Dispose) => Dispose
  ): PluginMetricsRegistry {
    const prefix = `qq_bot_plugin_${plugin.replace(/[^a-z0-9]/gu, "_")}_`;
    const define = (
      type: MetricType,
      name: string,
      help: string,
      options: MetricOptions & { buckets?: readonly number[] }
    ) => {
      if (!NAME_PATTERN.test(name)) {
        throw new Error(
          `invalid metric name "${name}"; use lowercase letters, digits and underscore`
        );
      }
      const fullName = `${prefix}${name}`;
      const existed = this.families.has(fullName);
      const family = this.define(plugin, fullName, type, help, options);
      if (!existed) {
        track(() => {
          if (this.families.get(fullName) === family) {
            this.families.delete(fullName);
          }
        });
      }
      return family;
    };
    return {
      counter: (name, help, options = {}) =>
        counterOf(define("counter", name, help, options)),
      gauge: (name, help, options = {}) =>
        gaugeOf(define("gauge", name, help, options)),
      histogram: (name, help, options = {}) =>
        histogramOf(define("histogram", name, help, options))
    };
  }

  /** Kernel-owned metrics; never removed. */
  public counter(
    name: string,
    help: string,
    labels: readonly string[] = []
  ): Counter {
    return counterOf(this.define("kernel", name, "counter", help, { labels }));
  }

  public histogram(
    name: string,
    help: string,
    labels: readonly string[] = [],
    buckets?: readonly number[]
  ): Histogram {
    return histogramOf(
      this.define("kernel", name, "histogram", help, {
        labels,
        ...(buckets ? { buckets } : {})
      })
    );
  }

  public render(): string {
    const lines: string[] = [];
    for (const [name, family] of [...this.families].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      lines.push(`# HELP ${name} ${escapeHelp(family.help)}`);
      lines.push(`# TYPE ${name} ${family.type}`);
      for (const { labels, value } of family.series.values()) {
        if (typeof value === "number") {
          lines.push(`${name}${labels ? `{${labels}}` : ""} ${format(value)}`);
          continue;
        }
        const join = (extra: string): string =>
          `{${[labels, extra].filter((part) => part.length > 0).join(",")}}`;
        family.buckets.forEach((bound, index) => {
          lines.push(
            `${name}_bucket${join(`le="${format(bound)}"`)} ${value.counts[index] ?? 0}`
          );
        });
        lines.push(`${name}_bucket${join('le="+Inf"')} ${value.count}`);
        lines.push(
          `${name}_sum${labels ? `{${labels}}` : ""} ${format(value.sum)}`,
          `${name}_count${labels ? `{${labels}}` : ""} ${value.count}`
        );
      }
    }
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }

  private define(
    owner: string,
    name: string,
    type: MetricType,
    help: string,
    options: MetricOptions & { buckets?: readonly number[] }
  ): Family {
    if (help.trim().length === 0) {
      throw new Error(`metric "${name}" needs a help text`);
    }
    const labelNames = [...(options.labels ?? [])];
    for (const label of labelNames) {
      if (!LABEL_PATTERN.test(label) || label === "le") {
        throw new Error(`invalid label "${label}" on metric "${name}"`);
      }
    }
    const buckets = [...(options.buckets ?? DEFAULT_BUCKETS)].sort(
      (a, b) => a - b
    );
    const existing = this.families.get(name);
    if (existing) {
      if (
        existing.owner !== owner ||
        existing.type !== type ||
        existing.labelNames.join() !== labelNames.join()
      ) {
        throw new Error(`metric "${name}" is already defined differently`);
      }
      return existing;
    }
    const family: Family = {
      type,
      help,
      labelNames,
      buckets,
      owner,
      series: new Map()
    };
    this.families.set(name, family);
    return family;
  }
}

function seriesFor(
  family: Family,
  labels: MetricLabels | undefined
): { value: number | HistogramSeries } | undefined {
  const given = Object.keys(labels ?? {});
  if (
    given.length !== family.labelNames.length ||
    !family.labelNames.every((name) => given.includes(name))
  ) {
    throw new Error(
      `metric expects labels [${family.labelNames.join(", ")}] but got [${given.join(", ")}]`
    );
  }
  const rendered = family.labelNames
    .map((name) => `${name}="${escapeLabel(String(labels?.[name]))}"`)
    .join(",");
  let series = family.series.get(rendered);
  if (!series) {
    if (family.series.size >= MAX_SERIES_PER_FAMILY) {
      // Unbounded label values would grow memory forever; drop the update.
      return undefined;
    }
    series = {
      labels: rendered,
      value:
        family.type === "histogram"
          ? { counts: family.buckets.map(() => 0), sum: 0, count: 0 }
          : 0
    };
    family.series.set(rendered, series);
  }
  return series;
}

function counterOf(family: Family): Counter {
  return {
    inc(labels, value = 1) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError("counter increments must be non-negative");
      }
      const series = seriesFor(family, labels);
      if (series) {
        series.value = (series.value as number) + value;
      }
    }
  };
}

function gaugeOf(family: Family): Gauge {
  return {
    set(value, labels) {
      const series = seriesFor(family, labels);
      if (series) {
        series.value = value;
      }
    },
    add(value, labels) {
      const series = seriesFor(family, labels);
      if (series) {
        series.value = (series.value as number) + value;
      }
    }
  };
}

function histogramOf(family: Family): Histogram {
  return {
    observe(value, labels) {
      if (!Number.isFinite(value)) {
        return;
      }
      const series = seriesFor(family, labels);
      if (!series) {
        return;
      }
      const histogram = series.value as HistogramSeries;
      histogram.sum += value;
      histogram.count += 1;
      family.buckets.forEach((bound, index) => {
        if (value <= bound) {
          histogram.counts[index] = (histogram.counts[index] ?? 0) + 1;
        }
      });
    }
  };
}

function escapeLabel(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n");
}

function escapeHelp(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n");
}

function format(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(6)));
}
