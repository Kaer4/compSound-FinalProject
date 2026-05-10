import { computePlaybackRate } from './alignment.js';

const FADE_BEATS   = 8;
const CURVE_LENGTH = 128;
const MIN_LOOKAHEAD = 0.1; // seconds
const FADE_BIAS_POWER = 0.4; // stronger bias — incoming is dominant by ~17% of the fade
/** Scale both legs during the fade to leave headroom when two full-scale tracks sum at the bus. */
const CROSSFADE_PEAK_HEADROOM = 0.94;
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
export function scheduleMix(masterTrack, incomingTrack, audioCtx, stretchedBuffer = null, fadeBeats = FADE_BEATS, tailGapS = 0) {
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
    fadeOut[i] = Math.cos(shapedT * Math.PI / 2) * CROSSFADE_PEAK_HEADROOM;
    fadeIn[i]  = Math.sin(shapedT * Math.PI / 2) * CROSSFADE_PEAK_HEADROOM;
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

  // EQ crossfade — bass swap (disabled for testing; re-enable by uncommenting):
  // Master's highpass sweeps 20 Hz → 300 Hz (removes bass as it exits).
  // Incoming's lowpass sweeps 300 Hz → 20000 Hz (bass arrives late, preventing mud).
  // const masterHPF = audioCtx.createBiquadFilter();
  // masterHPF.type = 'highpass';
  // masterHPF.frequency.setValueAtTime(20, audioCtx.currentTime);
  // masterTrack.gainNode.disconnect();
  // masterTrack.gainNode.connect(masterHPF);
  // masterHPF.connect(masterTrack.analyserNode);
  // masterHPF.frequency.setValueAtTime(20, nextDownbeatCtxTime);
  // masterHPF.frequency.linearRampToValueAtTime(300, fadeEndTime);

  // const inLPF = audioCtx.createBiquadFilter();
  // inLPF.type = 'lowpass';
  // inLPF.frequency.setValueAtTime(300, audioCtx.currentTime);
  // inLPF.frequency.setValueAtTime(300, nextDownbeatCtxTime);
  // inLPF.frequency.linearRampToValueAtTime(20000, fadeEndTime);
  // inLPF.connect(inGain);

  // Dummy HPF passthrough so return value stays consistent when EQ is re-enabled.
  const masterHPF = audioCtx.createGain();
  masterHPF.gain.setValueAtTime(1.0, audioCtx.currentTime);
  masterTrack.gainNode.disconnect();
  masterTrack.gainNode.connect(masterHPF);
  masterHPF.connect(masterTrack.analyserNode);

  // Private gain node for inSource so it can be faded out independently of inGain.
  const inSourceFade = audioCtx.createGain();
  inSourceFade.gain.setValueAtTime(1.0, audioCtx.currentTime);
  inSource.connect(inSourceFade);
  inSourceFade.connect(inGain); // direct — no LPF

  // Stretch path: buffer naturally ends at fadeDuration — no explicit stop needed.
  // Non-stretch path: buffer continues past the fade window, stop is required.
  if (!stretchedBuffer) {
    inSource.stop(fadeEndTime);
  }

  // Ramp inSourceFade to 0 just before the PV tail-gap silence begins (fadeEndTime − tailGapS).
  // Coordinated with contSourceFade in scheduleIncomingContinuation so both ramps cover the
  // same HANDOFF_S window and sum to 1 throughout — no dip when inSource goes silent.
  const rampEndTime = fadeEndTime - tailGapS;
  inSourceFade.gain.setValueAtTime(1.0, rampEndTime - HANDOFF_S);
  inSourceFade.gain.linearRampToValueAtTime(0.0, rampEndTime);

  // Schedule gain curves and stop master.
  // Pre-ramp master from 1.0 → fadeOut[0] over 10 ms so the curve entry is smooth (no pop).
  masterTrack.gainNode.gain.setValueAtTime(1.0, nextDownbeatCtxTime - 0.01);
  masterTrack.gainNode.gain.linearRampToValueAtTime(fadeOut[0], nextDownbeatCtxTime);
  masterTrack.gainNode.gain.setValueCurveAtTime(fadeOut, nextDownbeatCtxTime, fadeDuration);
  inGain.gain.setValueCurveAtTime(fadeIn, nextDownbeatCtxTime, fadeDuration);
  masterTrack.sourceNode.stop(fadeEndTime);

  return { nextDownbeatCtxTime, nextDownbeatBufferTime, fadeDuration, inSource, inSourceFade, inGain, masterHPF };
}
