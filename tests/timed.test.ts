import { describe, expect, it } from 'vitest';
import { MemoryMetrics, timed } from '../src/telemetry/timed.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('timed', () => {
  // S1-T4
  it('records the duration of a 50 ms function and status ok', async () => {
    const sink = new MemoryMetrics();
    const value = await timed(sink, 'turn-1', 'sleep', async () => {
      await sleep(50);
      return 'result';
    });
    expect(value).toBe('result');
    expect(sink.metrics).toHaveLength(1);
    const metric = sink.metrics[0]!;
    expect(metric.turnId).toBe('turn-1');
    expect(metric.step).toBe('sleep');
    expect(metric.status).toBe('ok');
    expect(Math.abs(metric.durationMs - 50)).toBeLessThanOrEqual(20);
    expect(Math.abs(metric.startedMs - Date.now())).toBeLessThan(1000);
  });

  // S1-T5
  it('records status error and rethrows', async () => {
    const sink = new MemoryMetrics();
    const boom = new Error('boom');
    await expect(
      timed(sink, 'turn-2', 'fail', () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.status).toBe('error');
  });
});
