// A small in-memory diagnostics event log. Callers must only pass safe,
// human-readable messages -- never passwords, private keys, or other secrets.
export type LogLevel = 'info' | 'warn' | 'error';

export interface DiagEvent {
  id: number;
  time: number;
  level: LogLevel;
  code?: string;
  message: string;
  detail?: string;
}

const MAX_EVENTS = 300;

export class DiagnosticsLog {
  private events: DiagEvent[] = [];
  private nextId = 1;
  private readonly listeners = new Set<(events: DiagEvent[]) => void>();

  log(level: LogLevel, message: string, opts?: { code?: string; detail?: string }): void {
    const event: DiagEvent = {
      id: this.nextId++,
      time: Date.now(),
      level,
      message,
      code: opts?.code,
      detail: opts?.detail,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(this.events.length - MAX_EVENTS);
    }
    this.notify();
  }

  info(message: string, opts?: { code?: string; detail?: string }): void {
    this.log('info', message, opts);
  }

  warn(message: string, opts?: { code?: string; detail?: string }): void {
    this.log('warn', message, opts);
  }

  error(message: string, opts?: { code?: string; detail?: string }): void {
    this.log('error', message, opts);
  }

  getEvents(): DiagEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
    this.notify();
  }

  subscribe(fn: (events: DiagEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    const snapshot = this.getEvents();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        // A misbehaving subscriber must not break the log or other listeners.
      }
    }
  }
}

export const diag = new DiagnosticsLog();
