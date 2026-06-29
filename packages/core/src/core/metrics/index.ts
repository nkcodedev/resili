/**
 * Low-cardinality metric labels.
 *
 * `requestId` must never be used as a metric label; it belongs in events and
 * traces, not metrics.
 *
 * @public
 */
export type Labels = Readonly<Record<string, string>>;

/**
 * Monotonically increasing metric instrument.
 *
 * @public
 */
export interface Counter {
  /**
   * Adds `value` to the counter for the optional label set.
   */
  add(value: number, labels?: Labels): void;
}

/**
 * Point-in-time metric instrument.
 *
 * @public
 */
export interface Gauge {
  /**
   * Sets the current gauge value for the optional label set.
   */
  set(value: number, labels?: Labels): void;
}

/**
 * Distribution metric instrument.
 *
 * @public
 */
export interface Histogram {
  /**
   * Records a sample value for the optional label set.
   */
  record(value: number, labels?: Labels): void;
}

/**
 * Vendor-neutral metrics recorder used by Resili policies.
 *
 * Implementations may bridge this interface to Prometheus, OpenTelemetry,
 * Datadog, New Relic, CloudWatch, or any other backend. Instrument failures
 * must not affect request execution.
 *
 * @public
 */
export interface MetricsRecorder {
  /**
   * Returns a counter instrument with the given name.
   */
  counter(name: string, help?: string): Counter;

  /**
   * Returns a gauge instrument with the given name.
   */
  gauge(name: string, help?: string): Gauge;

  /**
   * Returns a histogram instrument with the given name.
   */
  histogram(name: string, help?: string, buckets?: readonly number[]): Histogram;
}

/**
 * Default no-op metrics recorder.
 *
 * Use this when metrics are disabled. It is safe to share across clients and
 * never allocates per recording call.
 *
 * @public
 */
export const noopMetrics: MetricsRecorder = Object.freeze({
  counter(): Counter {
    return NOOP_COUNTER;
  },

  gauge(): Gauge {
    return NOOP_GAUGE;
  },

  histogram(): Histogram {
    return NOOP_HISTOGRAM;
  },
});

/**
 * Internal in-memory metrics recorder used by tests and future diagnostics.
 *
 * This class is intentionally not exported from the package root. It caches
 * instruments by name so repeated lookup stays cheap on hot paths.
 */
export class DefaultMetricsRecorder implements MetricsRecorder {
  readonly #counters = new Map<string, DefaultCounter>();
  readonly #gauges = new Map<string, DefaultGauge>();
  readonly #histograms = new Map<string, DefaultHistogram>();

  counter(name: string): Counter {
    let counter = this.#counters.get(name);

    if (counter === undefined) {
      counter = new DefaultCounter();
      this.#counters.set(name, counter);
    }

    return counter;
  }

  gauge(name: string): Gauge {
    let gauge = this.#gauges.get(name);

    if (gauge === undefined) {
      gauge = new DefaultGauge();
      this.#gauges.set(name, gauge);
    }

    return gauge;
  }

  histogram(name: string): Histogram {
    let histogram = this.#histograms.get(name);

    if (histogram === undefined) {
      histogram = new DefaultHistogram();
      this.#histograms.set(name, histogram);
    }

    return histogram;
  }
}

class DefaultCounter implements Counter {
  readonly #values = new Map<string, number>();

  add(value: number, labels?: Labels): void {
    if (!Number.isFinite(value)) {
      return;
    }

    const key = labelsKey(labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + value);
  }

  value(labels?: Labels): number {
    return this.#values.get(labelsKey(labels)) ?? 0;
  }
}

class DefaultGauge implements Gauge {
  readonly #values = new Map<string, number>();

  set(value: number, labels?: Labels): void {
    if (!Number.isFinite(value)) {
      return;
    }

    this.#values.set(labelsKey(labels), value);
  }

  value(labels?: Labels): number | undefined {
    return this.#values.get(labelsKey(labels));
  }
}

class DefaultHistogram implements Histogram {
  readonly #values = new Map<string, number[]>();

  record(value: number, labels?: Labels): void {
    if (!Number.isFinite(value)) {
      return;
    }

    const key = labelsKey(labels);
    const values = this.#values.get(key);

    if (values === undefined) {
      this.#values.set(key, [value]);
      return;
    }

    values.push(value);
  }

  values(labels?: Labels): readonly number[] {
    return this.#values.get(labelsKey(labels)) ?? [];
  }
}

const NOOP_COUNTER: Counter = Object.freeze({
  add(): void {
    // Intentionally empty.
  },
});

const NOOP_GAUGE: Gauge = Object.freeze({
  set(): void {
    // Intentionally empty.
  },
});

const NOOP_HISTOGRAM: Histogram = Object.freeze({
  record(): void {
    // Intentionally empty.
  },
});

function labelsKey(labels: Labels | undefined): string {
  if (labels === undefined) {
    return "";
  }

  const entries = Object.entries(labels);

  if (entries.length === 0) {
    return "";
  }

  entries.sort(compareLabelEntries);

  return entries.map(formatLabelEntry).join("\u0000");
}

function compareLabelEntries(
  [leftKey]: readonly [string, string],
  [rightKey]: readonly [string, string],
): number {
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function formatLabelEntry([key, value]: readonly [string, string]): string {
  return `${key}=${value}`;
}
