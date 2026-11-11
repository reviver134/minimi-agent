// Every step of a turn is timed and recorded against its turn_id.

export interface Metric {
  turnId: string;
  step: string;
  startedMs: number; // epoch milliseconds
  durationMs: number;
  status: 'ok' | 'error';
  tokensIn?: number;
  tokensOut?: number;
}

export interface MetricsSink {
  record(metric: Metric): void;
}

/** Keeps metrics in memory. Session 2 adds a sink that writes turn_metrics. */
export class MemoryMetrics implements MetricsSink {
  readonly metrics: Metric[] = [];
  record(metric: Metric): void {
    this.metrics.push(metric);
  }
}

export type TokenCounts = Pick<Metric, 'tokensIn' | 'tokensOut'>;

/**
 * Runs fn, records how long it took and whether it threw, and rethrows.
 * fn may fill in the token counts it is handed; they are recorded with the step.
 */
export async function timed<T>(
  sink: MetricsSink,
  turnId: string,
  step: string,
  fn: (tokens: TokenCounts) => T | Promise<T>,
): Promise<T> {
  const startedMs = Date.now();
  const t0 = performance.now();
  const tokens: TokenCounts = {};
  let status: Metric['status'] = 'ok';
  try {
    return await fn(tokens);
  } catch (err) {
    status = 'error';
    throw err;
  } finally {
    sink.record({ turnId, step, startedMs, durationMs: performance.now() - t0, status, ...tokens });
  }
}
