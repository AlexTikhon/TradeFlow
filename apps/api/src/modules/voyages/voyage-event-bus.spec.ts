import { describe, expect, it } from 'vitest';
import { type VoyageChange, VoyageEventBus } from './voyage-event-bus.js';

const V1 = '01990000-0000-7000-8003-000000000001';
const V2 = '01990000-0000-7000-8003-000000000002';
const change = (voyageId: string): VoyageChange => ({
  type: 'NOTICE_ISSUED',
  voyageId,
  contractId: '01990000-0000-7000-8008-000000000001',
});

describe('VoyageEventBus', () => {
  it("hands a change to its voyage's listeners only", () => {
    const bus = new VoyageEventBus();
    const heard: string[] = [];
    bus.subscribe(V1, () => heard.push('v1 a'));
    bus.subscribe(V1, () => heard.push('v1 b'));
    bus.subscribe(V2, () => heard.push('v2'));

    bus.publish(change(V1));

    expect(heard).toEqual(['v1 a', 'v1 b']);
  });

  it('keeps a failing listener from reaching the publisher or the other listeners', () => {
    const bus = new VoyageEventBus();
    const heard: string[] = [];
    bus.subscribe(V1, () => {
      throw new Error('listener broke');
    });
    bus.subscribe(V1, () => heard.push('after'));

    expect(() => {
      bus.publish(change(V1));
    }).not.toThrow();
    expect(heard).toEqual(['after']);
  });

  it('forgets a listener once it unsubscribes, and the voyage once none is left', () => {
    const bus = new VoyageEventBus();
    const heard: string[] = [];
    const first = bus.subscribe(V1, () => heard.push('first'));
    const second = bus.subscribe(V1, () => heard.push('second'));
    expect(bus.listenerCount(V1)).toBe(2);

    first();
    first(); // Twice is harmless.
    bus.publish(change(V1));
    second();

    expect(heard).toEqual(['second']);
    expect(bus.listenerCount(V1)).toBe(0);
    expect(bus.listenerCount()).toBe(0);
  });

  it('lets a listener unsubscribe while a change is being handed out', () => {
    const bus = new VoyageEventBus();
    const heard: string[] = [];
    const unsubscribe = bus.subscribe(V1, () => {
      heard.push('once');
      unsubscribe();
    });
    bus.subscribe(V1, () => heard.push('always'));

    bus.publish(change(V1));
    bus.publish(change(V1));

    expect(heard).toEqual(['once', 'always', 'always']);
  });
});
