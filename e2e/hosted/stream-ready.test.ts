import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reloadSignedInWithReady, type StreamMessage } from './stream-ready.js';

/*
 * A deterministic page model for restart.session's reload: a page clock that only moves when the
 * model moves it, and a stream history that belongs to one document (the instrumentation is an
 * init script, so every new document starts with an empty history).
 */
class FakePage {
  clock = 1_000_000;
  history: StreamMessage[] = [];
  reloads = 0;

  constructor(
    private readonly onSignedIn: (page: FakePage) => void,
    private readonly onReload: (page: FakePage) => void = () => undefined,
  ) {}

  receive(type: string) {
    this.history.push({ at: this.clock, type });
  }

  steps() {
    return {
      now: () => Promise.resolve(this.clock),
      reload: () => {
        this.reloads += 1;
        this.clock += 5;
        this.history = [];
        this.onReload(this);
        return Promise.resolve();
      },
      signedIn: () => {
        this.onSignedIn(this);
        return Promise.resolve();
      },
      messages: () => Promise.resolve([...this.history]),
    };
  }
}

const TIMEOUT_MS = 1_000;

void describe('reloadSignedInWithReady', () => {
  void it('accepts READY that the new document received before "Sign out" became visible', async () => {
    // The stream opens and READY arrives first; the app renders the signed-in header 40 ms later.
    const page = new FakePage((p) => {
      p.receive('READY');
      p.clock += 40;
    });
    const readyAt = await reloadSignedInWithReady(page.steps(), TIMEOUT_MS);
    assert.equal(page.reloads, 1);
    assert.equal(readyAt, 1_000_005);
  });

  void it('accepts READY that arrives after "Sign out" became visible', async () => {
    let polls = 0;
    const page = new FakePage((p) => {
      p.clock += 40;
    });
    const steps = page.steps();
    const readyAt = await reloadSignedInWithReady(
      {
        ...steps,
        messages: () => {
          polls += 1;
          if (polls === 2) {
            page.clock += 10;
            page.receive('READY');
          }
          return steps.messages();
        },
      },
      TIMEOUT_MS,
    );
    assert.equal(readyAt, 1_000_055);
  });

  void it('fails when the new document never receives READY', async () => {
    const page = new FakePage((p) => {
      p.receive('INSTRUCTIONS_UPDATED');
      p.clock += 40;
    });
    await assert.rejects(
      reloadSignedInWithReady(page.steps(), TIMEOUT_MS),
      /No READY message arrived/,
    );
  });

  void it("does not count the previous document's READY", async () => {
    const page = new FakePage((p) => {
      p.clock += 40;
    });
    page.receive('READY');
    await assert.rejects(
      reloadSignedInWithReady(page.steps(), TIMEOUT_MS),
      /No READY message arrived/,
    );
  });
});
