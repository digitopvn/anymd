export interface Span {
  name: string;
  start: number; // ms offset from trace start
  duration: number;
  status: 'ok' | 'error';
  meta?: Record<string, unknown>;
}

/** Minimal span recorder. Spans are persisted in the `traces` table and shown in the dashboard. */
export class Tracer {
  readonly id: string;
  readonly startedAt = Date.now();
  readonly spans: Span[] = [];

  constructor(id: string) {
    this.id = id;
  }

  async span<T>(name: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
    const start = Date.now();
    try {
      const out = await fn();
      this.spans.push({ name, start: start - this.startedAt, duration: Date.now() - start, status: 'ok', meta });
      return out;
    } catch (err) {
      this.spans.push({
        name,
        start: start - this.startedAt,
        duration: Date.now() - start,
        status: 'error',
        meta: { ...meta, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  note(name: string, meta?: Record<string, unknown>) {
    this.spans.push({ name, start: Date.now() - this.startedAt, duration: 0, status: 'ok', meta });
  }

  elapsed(): number {
    return Date.now() - this.startedAt;
  }
}
