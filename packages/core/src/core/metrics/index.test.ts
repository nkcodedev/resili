import { describe, expect, it } from "vitest";

import {
  DefaultMetricsRecorder,
  noopMetrics,
  type Counter,
  type Gauge,
  type Histogram,
  type MetricsRecorder,
} from "./index";

describe("noopMetrics", () => {
  it("returns stable no-op instruments", () => {
    const counter = noopMetrics.counter("requests");
    const gauge = noopMetrics.gauge("active");
    const histogram = noopMetrics.histogram("duration");

    expect(counter).toBe(noopMetrics.counter("other"));
    expect(gauge).toBe(noopMetrics.gauge("other"));
    expect(histogram).toBe(noopMetrics.histogram("other"));
    expect(Object.isFrozen(noopMetrics)).toBe(true);
    expect(Object.isFrozen(counter)).toBe(true);
    expect(Object.isFrozen(gauge)).toBe(true);
    expect(Object.isFrozen(histogram)).toBe(true);
  });

  it("never throws while recording", () => {
    expect(() => {
      noopMetrics.counter("requests").add(1, { service: "users" });
      noopMetrics.gauge("active").set(1, { service: "users" });
      noopMetrics.histogram("duration").record(12.5, { service: "users" });
    }).not.toThrow();
  });
});

describe("DefaultMetricsRecorder", () => {
  it("implements the MetricsRecorder contract", () => {
    const recorder: MetricsRecorder = new DefaultMetricsRecorder();

    expect(recorder.counter("requests")).toBeDefined();
    expect(recorder.gauge("active")).toBeDefined();
    expect(recorder.histogram("duration")).toBeDefined();
  });

  it("caches instruments by name and type", () => {
    const recorder = new DefaultMetricsRecorder();

    expect(recorder.counter("requests")).toBe(recorder.counter("requests"));
    expect(recorder.gauge("active")).toBe(recorder.gauge("active"));
    expect(recorder.histogram("duration")).toBe(recorder.histogram("duration"));
    expect(recorder.counter("same-name")).not.toBe(recorder.gauge("same-name"));
  });

  it("records counter values by normalized labels", () => {
    const counter = new DefaultMetricsRecorder().counter("requests") as TestCounter;

    counter.add(1, { service: "users", status: "success" });
    counter.add(2, { status: "success", service: "users" });
    counter.add(5, { service: "orders", status: "success" });

    expect(counter.value({ service: "users", status: "success" })).toBe(3);
    expect(counter.value({ service: "orders", status: "success" })).toBe(5);
    expect(counter.value()).toBe(0);
  });

  it("records counter values without labels", () => {
    const counter = new DefaultMetricsRecorder().counter("requests") as TestCounter;

    counter.add(1);
    counter.add(2, {});

    expect(counter.value()).toBe(3);
    expect(counter.value({})).toBe(3);
  });

  it("ignores non-finite counter values", () => {
    const counter = new DefaultMetricsRecorder().counter("requests") as TestCounter;

    counter.add(Number.NaN);
    counter.add(Number.POSITIVE_INFINITY);
    counter.add(1);

    expect(counter.value()).toBe(1);
  });

  it("records gauge values by normalized labels", () => {
    const gauge = new DefaultMetricsRecorder().gauge("active") as TestGauge;

    gauge.set(1, { service: "users", key: "primary" });
    gauge.set(2, { key: "primary", service: "users" });
    gauge.set(3, { service: "orders", key: "primary" });

    expect(gauge.value({ service: "users", key: "primary" })).toBe(2);
    expect(gauge.value({ service: "orders", key: "primary" })).toBe(3);
    expect(gauge.value({ service: "missing" })).toBeUndefined();
  });

  it("ignores non-finite gauge values", () => {
    const gauge = new DefaultMetricsRecorder().gauge("active") as TestGauge;

    gauge.set(1);
    gauge.set(Number.NaN);

    expect(gauge.value()).toBe(1);
  });

  it("records histogram samples by normalized labels", () => {
    const histogram = new DefaultMetricsRecorder().histogram("duration") as TestHistogram;

    histogram.record(10, { service: "users", operation: "getUser" });
    histogram.record(20, { operation: "getUser", service: "users" });
    histogram.record(30, { service: "orders", operation: "getOrder" });

    expect(histogram.values({ service: "users", operation: "getUser" })).toEqual([10, 20]);
    expect(histogram.values({ service: "orders", operation: "getOrder" })).toEqual([30]);
    expect(histogram.values({ service: "missing" })).toEqual([]);
  });

  it("records histogram samples without labels", () => {
    const histogram = new DefaultMetricsRecorder().histogram("duration") as TestHistogram;

    histogram.record(10);
    histogram.record(20, {});

    expect(histogram.values()).toEqual([10, 20]);
    expect(histogram.values({})).toEqual([10, 20]);
  });

  it("ignores non-finite histogram samples", () => {
    const histogram = new DefaultMetricsRecorder().histogram("duration") as TestHistogram;

    histogram.record(Number.NaN);
    histogram.record(10);

    expect(histogram.values()).toEqual([10]);
  });
});

interface TestCounter extends Counter {
  value(labels?: Readonly<Record<string, string>>): number;
}

interface TestGauge extends Gauge {
  value(labels?: Readonly<Record<string, string>>): number | undefined;
}

interface TestHistogram extends Histogram {
  values(labels?: Readonly<Record<string, string>>): readonly number[];
}
