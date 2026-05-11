import { computePlaybackRate, playbackRateForPvDryAlign } from './alignment.js';

const FADE_BEATS   = 8;
const CURVE_LENGTH = 128;
const MIN_LOOKAHEAD = 0.1; // seconds
const FADE_BIAS_POWER = 0.4;
export const HANDOFF_S = 0.095; //micro-crossfade between stretched slice and continuation to try and avoid silence at the end of the crossfade
export const HANDOFF_CURVE_LENGTH = 64; // samples for the micro-crossfade

let _handoffFadeOut = null;
let _handoffFadeIn = null;

function ensureHandoffCurves() {
  if (_handoffFadeOut) return;
  _handoffFadeOut = new Float32Array(HANDOFF_CURVE_LENGTH);
  _handoffFadeIn = new Float32Array(HANDOFF_CURVE_LENGTH);
  for (let i = 0; i < HANDOFF_CURVE_LENGTH; i++) {
    const t = i / (HANDOFF_CURVE_LENGTH - 1);
    _handoffFadeOut[i] = Math.cos((t * Math.PI) / 2);
    _handoffFadeIn[i] = Math.sin((t * Math.PI) / 2);
  }
}

// Equal-power fade-out 1->0 for PV slice branch (paired with getHandoffFadeInCurve on continuation)
export function getHandoffFadeOutCurve() {
  ensureHandoffCurves();
  return _handoffFadeOut;
}

// Equal-power fade-in 0->1 for continuation branch
export function getHandoffFadeInCurve() {
  ensureHandoffCurves();
  return _handoffFadeIn;
}

// Scales both decks during the fade window — extra headroom vs clipping when PCM + PV peaks align
const CROSSFADE_HEADROOM = 0.93;

// Crossfade length in seconds from master BPM (master plays at playbackRate 1)
export function getFadeDurationSeconds(masterBpm, fadeBeats = FADE_BEATS) {
  return (60 / masterBpm) * fadeBeats;
}

/**
 * Schedules a beat-locked equal-power crossfade from masterTrack to incomingTrack
 *
 * @param {object} masterTrack    - currently playing track state object
 * @param {object} incomingTrack  - track to fade in (not yet playing)
 * @param {AudioContext} audioCtx
 * @param {AudioBuffer|null} stretchedBuffer
 *   If provided, this pre-processed buffer is played instead of incomingTrack.buffer
 *   and playbackRate is left at 1.0. The cue offset is scaled into stretched time
 * @returns {{ nextDownbeatCtxTime, nextDownbeatBufferTime, fadeDuration, inSource, inSourceFade, inGain, dryAlignSource, dryBranchGain }}
 *   `dryAlignSource` / `dryBranchGain` are non-null only on PV path (dual playback into `inGain`)
 *   or null if no upcoming downbeat was found
 *
 * Incoming fade source is always stopped at `nextDownbeatCtxTime + fadeDuration` so overlap
 * matches the equal-power window (handles stretched buffers longer/shorter than the fade)
 */
export function scheduleMix(masterTrack, incomingTrack, audioCtx, stretchedBuffer = null, fadeBeats = FADE_BEATS, tailGapS = 0) {
  const playhead = masterTrack.cueTime + (audioCtx.currentTime - masterTrack.startContextTime);

  // Find the next downbeat in the master's beat grid after the current playhead
  const nextDownbeatBufferTime = masterTrack.beatTimes.find(t => t > playhead);
  if (nextDownbeatBufferTime === undefined) return null;

  let nextDownbeatCtxTime =
    masterTrack.startContextTime + (nextDownbeatBufferTime - masterTrack.cueTime);

  // Ensures we're not scheduling in the past
  nextDownbeatCtxTime = Math.max(nextDownbeatCtxTime, audioCtx.currentTime + MIN_LOOKAHEAD);

  const fadeDuration = getFadeDurationSeconds(masterTrack.bpm, fadeBeats);

  // Equal-power curves
  const fadeOut = new Float32Array(CURVE_LENGTH); // cos: 1 -> 0
  const fadeIn  = new Float32Array(CURVE_LENGTH); // sin: 0 -> 1
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const t = i / (CURVE_LENGTH - 1);
    // Bias fade progression so incoming gains presence earlier while preserving
    // the sin/cos relationship. Normalize each pair by their amplitude sum so
    // fadeOut[i] + fadeIn[i] = 1.0 at every sample so it prevents clipping when
    // both tracks are summed 
    const shapedT = Math.pow(t, FADE_BIAS_POWER);
    const out  = Math.cos(shapedT * Math.PI / 2);
    const in_  = Math.sin(shapedT * Math.PI / 2);
    const norm = out + in_; 
    fadeOut[i] = (out / norm) * CROSSFADE_HEADROOM;
    fadeIn[i]  = (in_ / norm) * CROSSFADE_HEADROOM;
  }

  // Build incoming audio graph 
  const inGain = audioCtx.createGain();
  inGain.gain.setValueAtTime(0, audioCtx.currentTime);
  inGain.connect(audioCtx.destination);

  const inSource = audioCtx.createBufferSource();

  if (stretchedBuffer) {
    // Phase vocoder path: play the pre-stretched buffer at natural rate.
    // stretchedBuffer is a slice already starting at incomingTrack.cueTime,
    // so offset into it is always 0
    inSource.buffer = stretchedBuffer;
    inSource.start(nextDownbeatCtxTime, 0);
  } else {
    // Small BPM diff: match master tempo only during the fade; continuation plays at rate 1
    const r = computePlaybackRate(masterTrack.bpm, incomingTrack.bpm);
    inSource.buffer = incomingTrack.buffer;
    inSource.playbackRate.value = r;
    inSource.start(nextDownbeatCtxTime, incomingTrack.cueTime);
  }

  const fadeEndTime = nextDownbeatCtxTime + fadeDuration;
  const rampEndTime = fadeEndTime - tailGapS;
  const handoffStart = rampEndTime - HANDOFF_S;

  let dryAlignSource = null;
  let dryBranchGain = null;

  //HERE IS WHERE I TRIED TO DO A BASS SWAP BUT IT DIDN'T WORK SO I COMMENTED IT OUT
  // demoed this in class but that didn't go so well...

  // EQ crossfade — bass swap (disabled; re-enable by uncommenting and restoring masterHPF wiring):
  // Master's highpass sweeps 20 Hz -> 300 Hz (removes bass as it exits).
  // Incoming's lowpass sweeps 300 Hz -> 20000 Hz (bass arrives late, preventing mud).
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

  // Private gain node for inSource so it can be faded out independently of inGain
  const inSourceFade = audioCtx.createGain();
  inSourceFade.gain.setValueAtTime(1.0, audioCtx.currentTime);
  inSource.connect(inSourceFade);
  inSourceFade.connect(inGain); 

  // PV path: tempo-matched dry playback from downbeat (silent until handoff), blended with PV at tail
  if (stretchedBuffer) {
    dryAlignSource = audioCtx.createBufferSource();
    dryAlignSource.buffer = incomingTrack.buffer;
    dryAlignSource.playbackRate.value = playbackRateForPvDryAlign(masterTrack.bpm, incomingTrack.bpm);
    dryAlignSource.start(nextDownbeatCtxTime, incomingTrack.cueTime);
    dryAlignSource.stop(rampEndTime);

    dryBranchGain = audioCtx.createGain();
    dryBranchGain.gain.setValueAtTime(0, audioCtx.currentTime);
    dryBranchGain.gain.setValueAtTime(0, nextDownbeatCtxTime);
    dryBranchGain.gain.setValueAtTime(0, handoffStart);
    const dryFadeIn = getHandoffFadeInCurve();
    dryBranchGain.gain.setValueCurveAtTime(dryFadeIn, handoffStart, HANDOFF_S);

    dryAlignSource.connect(dryBranchGain);
    dryBranchGain.connect(inGain);
  }

  // Stretch path: buffer naturally ends at fadeDuration 
  // Non-stretch path: buffer continues past the fade window, stop is required
  if (!stretchedBuffer) {
    inSource.stop(fadeEndTime);
  }

  // Ramp inSourceFade to 0 before PV tail silence (fadeEndTime − tailGapS)
  // Equal-power cos curve over HANDOFF_S — paired with sin ramp on dryBranchGain (PV path) or contSourceFade (rate path)
  const pvHandoffFadeOut = getHandoffFadeOutCurve();
  inSourceFade.gain.setValueAtTime(1.0, handoffStart);
  inSourceFade.gain.setValueCurveAtTime(pvHandoffFadeOut, handoffStart, HANDOFF_S);

  // Schedule gain curves and stop master.
  // fadeOut[0] is CROSSFADE_HEADROOM (was unity before headroom) — tiny step down from 1.0 possible
  masterTrack.gainNode.gain.setValueCurveAtTime(fadeOut, nextDownbeatCtxTime, fadeDuration);
  inGain.gain.setValueCurveAtTime(fadeIn, nextDownbeatCtxTime, fadeDuration);
  // Curve ends at CROSSFADE_HEADROOM 
  // ease to 1.0 so continuation plays at unity (headroom applied only during the overlap window)
  const epsilon = 1 / audioCtx.sampleRate;
  inGain.gain.setValueAtTime(fadeIn[CURVE_LENGTH - 1], fadeEndTime + epsilon);
  inGain.gain.linearRampToValueAtTime(1.0, fadeEndTime + 0.04);
  masterTrack.sourceNode.stop(fadeEndTime);

  return {
    nextDownbeatCtxTime,
    nextDownbeatBufferTime,
    fadeDuration,
    inSource,
    inSourceFade,
    inGain,
    dryAlignSource,
    dryBranchGain,
  };
}
