import { type VoyageChange, VoyageEventBus } from '../../src/modules/voyages/voyage-event-bus.js';

/**
 * The real in-memory bus, recording what was published, which a test can make fail: `failNext`
 * makes the next publications throw before reaching any listener, like a notifier that is down.
 */
export class TestEventBus extends VoyageEventBus {
  /** Every change published (and not failed), in order. */
  readonly published: VoyageChange[] = [];
  private failures = 0;

  failNext(times = 1): void {
    this.failures = times;
  }

  reset(): void {
    this.failures = 0;
    this.published.length = 0;
  }

  override publish(change: VoyageChange): void {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('event bus unavailable');
    }
    this.published.push(change);
    super.publish(change);
  }
}
