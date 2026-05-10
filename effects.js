/**
 * Per-track effects chain.
 *
 * Signal flow:
 *   inputNode
 *     → eq.low (lowshelf 320 Hz)
 *     → eq.mid (peaking 1 kHz)
 *     → eq.high (highshelf 3.2 kHz)
 *     → filter.node (LPF/HPF, neutral when disabled)
 *     → delay.dry  ──┐
 *     → delay.node → delay.feedback (loop back to delay.node)
 *     → delay.wet  ──┴→ delay.mix (summing node)
 *     → reverb.dry      ──┐
 *     → reverb.convolver → reverb.wet ──┴→ outputNode
 */

/**
 * Create all effect nodes for one track.
 * Parameters are set to neutral defaults (no audible effect).
 * @param {AudioContext} audioCtx
 * @returns {object} chain
 */
export function createEffectsChain(audioCtx) {
  // ── 3-band EQ ──────────────────────────────────────────────────────────────
  const eqLow = audioCtx.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.value = 320;
  eqLow.gain.value = 0;

  const eqMid = audioCtx.createBiquadFilter();
  eqMid.type = 'peaking';
  eqMid.frequency.value = 1000;
  eqMid.Q.value = 1.0;
  eqMid.gain.value = 0;

  const eqHigh = audioCtx.createBiquadFilter();
  eqHigh.type = 'highshelf';
  eqHigh.frequency.value = 3200;
  eqHigh.gain.value = 0;

  // ── Resonant filter ─────────────────────────────────────────────────────────
  // Neutral when disabled: LPF at 20 kHz (or HPF at 20 Hz) passes everything.
  const filterNode = audioCtx.createBiquadFilter();
  filterNode.type = 'lowpass';
  filterNode.frequency.value = 20000;
  filterNode.Q.value = 1.0;

  // ── Delay ───────────────────────────────────────────────────────────────────
  const delayNode = audioCtx.createDelay(2.0);
  delayNode.delayTime.value = 0.375;

  const delayFeedback = audioCtx.createGain();
  delayFeedback.gain.value = 0.4;

  const delayDry = audioCtx.createGain();
  delayDry.gain.value = 1.0;   // wet=0 by default → dry=1 → pass-through

  const delayWet = audioCtx.createGain();
  delayWet.gain.value = 0.0;

  const delayMix = audioCtx.createGain(); // summing node, always gain=1
  delayMix.gain.value = 1.0;

  // ── Reverb ──────────────────────────────────────────────────────────────────
  const convolver = audioCtx.createConvolver();
  convolver.buffer = buildIR(audioCtx, 2.5, 2.0);

  const reverbDry = audioCtx.createGain();
  reverbDry.gain.value = 1.0;  // wet=0 by default → dry=1 → pass-through

  const reverbWet = audioCtx.createGain();
  reverbWet.gain.value = 0.0;

  return {
    eq: { low: eqLow, mid: eqMid, high: eqHigh },
    filter: { node: filterNode, enabled: false },
    delay: {
      node: delayNode,
      feedback: delayFeedback,
      dry: delayDry,
      wet: delayWet,
      mix: delayMix,
      enabled: false,
    },
    reverb: { convolver, dry: reverbDry, wet: reverbWet, enabled: false },
  };
}

/**
 * Wire the effects chain between inputNode and outputNode.
 * Safe to call multiple times after disconnectChain().
 * @param {object} chain
 * @param {AudioNode} inputNode  - typically the track's GainNode
 * @param {AudioNode} outputNode - typically the track's AnalyserNode
 */
export function connectChain(chain, inputNode, outputNode) {
  const { eq, filter, delay, reverb } = chain;

  // EQ
  inputNode.connect(eq.low);
  eq.low.connect(eq.mid);
  eq.mid.connect(eq.high);

  // Filter
  eq.high.connect(filter.node);

  // Delay — dry path bypasses delayNode, wet path goes through it + feedback loop
  filter.node.connect(delay.dry);
  filter.node.connect(delay.node);
  delay.node.connect(delay.feedback);
  delay.feedback.connect(delay.node); // feedback loop
  delay.node.connect(delay.wet);
  delay.dry.connect(delay.mix);
  delay.wet.connect(delay.mix);

  // Reverb — dry bypasses convolver
  delay.mix.connect(reverb.dry);
  delay.mix.connect(reverb.convolver);
  reverb.convolver.connect(reverb.wet);
  reverb.dry.connect(outputNode);
  reverb.wet.connect(outputNode);
}

/**
 * Disconnect all nodes in the chain (internal + boundary connections).
 * Node objects and their parameter values are preserved for reconnection.
 * @param {object|null} chain
 */
export function disconnectChain(chain) {
  if (!chain) return;
  const { eq, filter, delay, reverb } = chain;
  const nodes = [
    eq.low, eq.mid, eq.high,
    filter.node,
    delay.node, delay.feedback, delay.dry, delay.wet, delay.mix,
    reverb.convolver, reverb.dry, reverb.wet,
  ];
  for (const node of nodes) {
    try { node.disconnect(); } catch (_) { /* already disconnected */ }
  }
}

/**
 * Build a programmatic reverb impulse response (exponential noise decay).
 * @param {AudioContext} audioCtx
 * @param {number} duration  - IR length in seconds
 * @param {number} decay     - exponent controlling tail falloff (higher = shorter tail)
 * @returns {AudioBuffer}
 */
export function buildIR(audioCtx, duration = 2.5, decay = 2.0) {
  const len = Math.floor(audioCtx.sampleRate * duration);
  const ir  = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return ir;
}
