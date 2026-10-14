import { sleep } from 'n8n-workflow';

/** Time source and pause of the polling loops (tests swap them for instant fakes). */
export const clock = {
  now: (): number => Date.now(),
  sleep: async (ms: number): Promise<void> => await sleep(ms),
};

export interface PollOptions<T> {
  /** One look at the job or run. */
  read: () => Promise<T>;
  /** True once there is nothing left to wait for. */
  settled: (value: T) => boolean;
  intervalMs: number;
  timeoutMs: number;
  /** The execution's cancel signal: a cancelled workflow stops polling at once. */
  signal?: AbortSignal;
}

export interface PollResult<T> {
  value: T;
  /** False when the time ran out (or the execution was cancelled) before it settled. */
  settled: boolean;
}

/** Reads until `settled`, pausing `intervalMs` between looks, for at most `timeoutMs`. */
export async function pollUntil<T>(options: PollOptions<T>): Promise<PollResult<T>> {
  const deadline = clock.now() + options.timeoutMs;
  for (;;) {
    const value = await options.read();
    if (options.settled(value)) return { value, settled: true };
    const left = deadline - clock.now();
    if (left <= 0 || options.signal?.aborted) return { value, settled: false };
    await clock.sleep(Math.min(options.intervalMs, left));
    if (options.signal?.aborted) return { value, settled: false };
  }
}
