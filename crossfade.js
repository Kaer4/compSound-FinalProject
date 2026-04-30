import { computePlaybackRate } from './alignment.js';

const FADE_BEATS   = 8;
const CURVE_LENGTH = 128;
const MIN_LOOKAHEAD = 0.1; // seconds
const FADE_BIAS_POWER = 0.82; // <1 favors incoming earlier during the fade
export const HANDOFF_S = 0.03; // micro-crossfade between stretched slice and continuation

/** Crossfade length in seconds from master BPM (master plays at playbackRate 1). */
export function getFadeDurationSeconds(masterBpm, fadeBeats = FADE_BEATS) {
  return (60 / masterBpm) * fadeBeats;
}

/**
 * Schedules a beat-locked equal-power crossfade from masterTrack to incomingTrack.
 *
 * @param {object} masterTrack    - currently playing track state object
 * @param {object} incomingTrack  - track to fade in (not yet playing)
 * @param {AudioContext} audioCtx
 * @param {AudioBuffer|null} stretchedBuffer
 *   If provided, this pre-processed buffer is played instead of incomingTrack.buffer
 *   and playbackRate is left at 1.0. The cue offset is scaled into stretched time.
 * @returns {{ nextDownbeatCtxTime, nextDownbeatBufferTime, fadeDuration, inSource, inGain }}
 *   or null if no upcoming downbeat was found
 *
 * Incoming fade source is always stopped at `nextDownbeatCtxTime + fadeDuration` so overlap
 * matches the equal-power window (handles stretched buffers longer/shorter than the fade).
 */
export function scheduleMix(masterTrack, incomingTrack, audioCtx, stretchedBuffer = null, fadeBeats = FADE_BEATS) {
  const playhead = masterTrack.cueTime + (audioCtx.currentTime - masterTrack.startContextTime);

  // Find the next downbeat in the master's beat grid after the current playhead.
  const nextDownbeatBufferTime = masterTrack.beatTimes.find(t => t > playhead);
  if (nextDownbeatBufferTime === undefined) return null;

  let nextDownbeatCtxTime =
    masterTrack.startContextTime + (nextDownbeatBufferTime - masterTrack.cueTime);

  // Ensure we're not scheduling in the past.
  nextDownbeatCtxTime = Math.max(nextDownbeatCtxTime, audioCtx.currentTime + MIN_LOOKAHEAD);

  const fadeDuration = getFadeDurationSeconds(masterTrack.bpm, fadeBeats);

  // Equal-power curves.
  const fadeOut = new Float32Array(CURVE_LENGTH); // cos: 1 → 0
  const fadeIn  = new Float32Array(CURVE_LENGTH); // sin: 0 → 1
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const t = i / (CURVE_LENGTH - 1);
    // Bias fade progression so incoming gains presence earlier while preserving
    // equal-power pairing (sin/cos of the same angle).
    const shapedT = Math.pow(t, FADE_BIAS_POWER);
    fadeOut[i] = Math.cos(shapedT * Math.PI / 2);
    fadeIn[i]  = Math.sin(shapedT * Math.PI / 2);
  }

  // Build incoming audio graph — gain starts at 0 so there's no pop at entry.
  const inGain = audioCtx.createGain();
  inGain.gain.setValueAtTime(0, audioCtx.currentTime);
  inGain.connect(audioCtx.destination);

  const inSource = audioCtx.createBufferSource();

  if (stretchedBuffer) {
    // Phase vocoder path: play the pre-stretched buffer at natural rate.
    // stretchedBuffer is a slice already starting at incomingTrack.cueTime,
    // so offset into it is always 0.
    inSource.buffer = stretchedBuffer;
    inSource.start(nextDownbeatCtxTime, 0);
  } else {
    // Small BPM diff: match master tempo only during the fade; continuation plays at rate 1.
    const r = computePlaybackRate(masterTrack.bpm, incomingTrack.bpm);
    inSource.buffer = incomingTrack.buffer;
    inSource.playbackRate.value = r;
    inSource.start(nextDownbeatCtxTime, incomingTrack.cueTime);
  }

  const fadeEndTime = nextDownbeatCtxTime + fadeDuration;

  // EQ crossfade — bass swap:
  // Master's highpass sweeps 20 Hz → 300 Hz (removes bass as it exits).
  // Incoming's lowpass sweeps 300 Hz → 20000 Hz (bass arrives late, preventing mud).
  const masterHPF = audioCtx.createBiquadFilter();
  masterHPF.type = 'highpass';
  masterHPF.frequency.setValueAtTime(20, audioCtx.currentTime);
  masterTrack.gainNode.disconnect();
  masterTrack.gainNode.connect(masterHPF);
  masterHPF.connect(masterTrack.analyserNode);
  masterHPF.frequency.setValueAtTime(20, nextDownbeatCtxTime);
  masterHPF.frequency.linearRampToValueAtTime(300, fadeEndTime);

  const inLPF = audioCtx.createBiquadFilter();
  inLPF.type = 'lowpass';
  inLPF.frequency.setValueAtTime(300, audioCtx.currentTime);
  inLPF.frequency.setValueAtTime(300, nextDownbeatCtxTime);
  inLPF.frequency.linearRampToValueAtTime(20000, fadeEndTime);
  inLPF.connect(inGain);

  // Private gain node for inSource so it can be faded out independently of inGain.
  const inSourceFade = audioCtx.createGain();
  inSourceFade.gain.setValueAtTime(1.0, audioCtx.currentTime);
  inSource.connect(inSourceFade);
  inSourceFade.connect(inLPF);

  // Stretch path: buffer naturally ends at fadeDuration — no explicit stop needed.
  // Non-stretch path: buffer continues past the fade window, stop is required.
  if (!stretchedBuffer) {
    inSource.stop(fadeEndTime);
  }

  // Ramp inSourceFade to 0 over the last HANDOFF_S of the fade so the handoff
  // to the continuation source is a micro-crossfade rather than an abrupt cut.
  inSourceFade.gain.setValueAtTime(1.0, fadeEndTime - HANDOFF_S);
  inSourceFade.gain.linearRampToValueAtTime(0.0, fadeEndTime);

  // Schedule gain curves and stop master.
  masterTrack.gainNode.gain.setValueCurveAtTime(fadeOut, nextDownbeatCtxTime, fadeDuration);
  inGain.gain.setValueCurveAtTime(fadeIn, nextDownbeatCtxTime, fadeDuration);
  masterTrack.sourceNode.stop(fadeEndTime);

  return { nextDownbeatCtxTime, nextDownbeatBufferTime, fadeDuration, inSource, inSourceFade, inGain, masterHPF };
}
