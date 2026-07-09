// Audio cue for a mapped reception (issue #7). Web Audio is injected so the tone
// generation is unit-testable without a browser. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { createBeeper } from '../src/beeper.js';

// Minimal fake Web Audio graph that records what the beeper builds.
function fakeAudio(initialState = 'running') {
  const events = { started: [], stopped: [], resumed: 0 };
  const ctx = {
    state: initialState,
    currentTime: 10,
    resume() { events.resumed++; this.state = 'running'; },
    destination: { id: 'dest' },
    createOscillator() {
      const osc = {
        type: null, frequency: { value: null }, _connectedTo: null,
        connect(n) { this._connectedTo = n; },
        start(t) { events.started.push(t); },
        stop(t) { events.stopped.push(t); },
      };
      events.lastOsc = osc;
      return osc;
    },
    createGain() {
      const g = { gain: { value: null }, _connectedTo: null, connect(n) { this._connectedTo = n; } };
      events.lastGain = g;
      return g;
    },
  };
  function Ctx() { return ctx; }
  return { Ctx, ctx, events };
}

test('beep builds a tone and schedules start before stop, returns true', () => {
  const { Ctx, ctx, events } = fakeAudio();
  const beeper = createBeeper({ AudioContext: Ctx });
  const ok = beeper.beep();
  assert.strictEqual(ok, true);
  assert.strictEqual(events.started.length, 1);
  assert.strictEqual(events.stopped.length, 1);
  assert.ok(events.stopped[0] > events.started[0], 'stop after start');
  assert.strictEqual(events.started[0], ctx.currentTime);
  // routed osc → gain → destination
  assert.strictEqual(events.lastOsc._connectedTo, events.lastGain);
  assert.strictEqual(events.lastGain._connectedTo, ctx.destination);
  assert.ok(events.lastOsc.frequency.value > 0, 'a pitch is set');
});

test('a suspended context is resumed before playing (autoplay unlock)', () => {
  const { Ctx, events } = fakeAudio('suspended');
  const beeper = createBeeper({ AudioContext: Ctx });
  beeper.beep();
  assert.strictEqual(events.resumed, 1);
});

test('ensure() creates and unlocks the context without playing a tone', () => {
  const { Ctx, events } = fakeAudio('suspended');
  const beeper = createBeeper({ AudioContext: Ctx });
  beeper.ensure();
  assert.strictEqual(events.resumed, 1);
  assert.strictEqual(events.started.length, 0, 'ensure does not beep');
});

test('beep is a no-op returning false when Web Audio is unavailable', () => {
  const beeper = createBeeper({ AudioContext: undefined });
  assert.strictEqual(beeper.beep(), false);
});
