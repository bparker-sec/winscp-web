import { describe, it, expect, beforeEach } from 'vitest';
import { DiagnosticsLog } from './log';

describe('DiagnosticsLog', () => {
  let log: DiagnosticsLog;

  beforeEach(() => {
    log = new DiagnosticsLog();
  });

  it('logs events retrievable via getEvents', () => {
    log.info('hello');
    log.warn('careful', { code: 'W1' });
    log.error('boom', { code: 'E1', detail: 'stack trace' });
    const events = log.getEvents();
    expect(events).toHaveLength(3);
    expect(events[0].level).toBe('info');
    expect(events[0].message).toBe('hello');
    expect(events[1].level).toBe('warn');
    expect(events[1].code).toBe('W1');
    expect(events[2].level).toBe('error');
    expect(events[2].detail).toBe('stack trace');
  });

  it('assigns monotonically increasing ids', () => {
    log.info('a');
    log.info('b');
    log.info('c');
    const ids = log.getEvents().map((e) => e.id);
    expect(ids[1]).toBeGreaterThan(ids[0]);
    expect(ids[2]).toBeGreaterThan(ids[1]);
  });

  it('caps the ring buffer at the max size and drops the oldest', () => {
    const MAX = 300;
    for (let i = 0; i < MAX + 50; i++) {
      log.info(`event-${i}`);
    }
    const events = log.getEvents();
    expect(events).toHaveLength(MAX);
    expect(events[0].message).toBe('event-50');
    expect(events[events.length - 1].message).toBe(`event-${MAX + 49}`);
  });

  it('clear empties the log', () => {
    log.info('one');
    log.clear();
    expect(log.getEvents()).toHaveLength(0);
  });

  it('subscribe fires on log with the current snapshot', () => {
    const snapshots: number[] = [];
    const unsub = log.subscribe((events) => snapshots.push(events.length));
    log.info('one');
    log.info('two');
    expect(snapshots).toEqual([1, 2]);
    unsub();
    log.info('three');
    expect(snapshots).toEqual([1, 2]);
  });

  it('subscribe fires on clear', () => {
    log.info('one');
    const snapshots: number[] = [];
    log.subscribe((events) => snapshots.push(events.length));
    log.clear();
    expect(snapshots).toEqual([0]);
  });
});
