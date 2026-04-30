import { computePlaybackRate } from './alignment.js';

const FADE_BEATS   = 8;
const CURVE_LENGTH = 128;
const MIN_LOOKAHEAD = 0.1; // seconds

/** Crossfade length in seconds from master BPM (master plays at playbackRate 1). */
export function getFadeDurationSeconds(masterBpm) {
  return (60 / masterBpm) * FADE_BEATS;
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
export function scheduleMix(masterTrack, incomingTrack, audioCtx, stretchedBuffer = null) {
  const playhead = masterTrack.cueTime + (audioCtx.currentTime - masterTrack.startContextTime);

  // Find the next downbeat in the master's beat grid after the current playhead.
  const nextDownbeatBufferTime = masterTrack.beatTimes.find(t => t > playhead);
  if (nextDownbeatBufferTime === undefined) return null;

  let nextDownbeatCtxTime =
    masterTrack.startContextTime + (nextDownbeatBufferTime - masterTrack.cueTime);

  // Ensure we're not scheduling in the past.
  nextDownbeatCtxTime = Math.max(nextDownbeatCtxTime, audioCtx.currentTime + MIN_LOOKAHEAD);

  const fadeDuration = getFadeDurationSeconds(masterTrack.bpm);

  // Equal-power curves.
  const fadeOut = new Float32Array(CURVE_LENGTH); // cos: 1 → 0
  const fadeIn  = new Float32Array(CURVE_LENGTH); // sin: 0 → 1
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const t = i / (CURVE_LENGTH - 1);
    fadeOut[i] = Math.cos(t * Math.PI / 2);
    fadeIn[i]  = Math.sin(t * Math.PI / 2);
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

  inSource.connect(inGain);
  inSource.stop(nextDownbeatCtxTime + fadeDuration);

  // Schedule gain curves and stop master.
  masterTrack.gainNode.gain.setValueCurveAtTime(fadeOut, nextDownbeatCtxTime, fadeDuration);
  inGain.gain.setValueCurveAtTime(fadeIn, nextDownbeatCtxTime, fadeDuration);
  masterTrack.sourceNode.stop(nextDownbeatCtxTime + fadeDuration);

  return { nextDownbeatCtxTime, nextDownbeatBufferTime, fadeDuration, inSource, inGain };
}
