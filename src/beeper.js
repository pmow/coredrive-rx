// Short audio cue on each mapped reception, so the operator gets feedback without
// looking at the phone (issue #7). Web Audio only — no asset to ship, and the tone
// is synthesised on the fly. AudioContext is injectable so tone generation is
// unit-testable without a browser (mirrors wakelock.js's dependency injection).
//
// Autoplay policy: a context created outside a user gesture starts 'suspended'.
// Call ensure() from a click/change handler to unlock it; beep() also resumes
// defensively so a first tone is never silently dropped.

export const BEEP_FREQ_HZ = 880;   // A5 — a clear, short "bloop"
export const BEEP_DUR_MS = 90;
export const BEEP_VOLUME = 0.15;   // gentle; this fires on every mapped reception

export function createBeeper(deps = {}) {
  const Ctx =
    deps.AudioContext ??
    (typeof AudioContext !== 'undefined'
      ? AudioContext
      : typeof webkitAudioContext !== 'undefined'
        ? webkitAudioContext
        : undefined);
  let ctx = null;

  // ensure() lazily creates the context and resumes it if the autoplay policy left
  // it suspended. Returns the context, or null when Web Audio is unavailable.
  function ensure() {
    if (!Ctx) return null;
    if (!ctx) ctx = new Ctx();
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    return ctx;
  }

  // beep() plays one short tone. Returns false (no-op) when Web Audio is unavailable.
  function beep(opts = {}) {
    const c = ensure();
    if (!c) return false;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = opts.freq ?? BEEP_FREQ_HZ;
    gain.gain.value = opts.volume ?? BEEP_VOLUME;
    osc.connect(gain);
    gain.connect(c.destination);
    const t = c.currentTime;
    osc.start(t);
    osc.stop(t + (opts.durMs ?? BEEP_DUR_MS) / 1000);
    return true;
  }

  return { ensure, beep };
}
