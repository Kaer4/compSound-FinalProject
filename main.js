import { detectBPM } from './analysis.js';
import { drawFrame } from './visualizer.js';
import {
  computePlaybackRate,
  needsTimeStretch,
  timeStretchBuffer,
  extractSegment,
  trimBufferToWallClock,
  measureTailSilence,
  clipBuffer,
  playbackRateForPvDryAlign,
  snapBufferOffset,
} from './alignment.js';
import {
  scheduleMix,
  getFadeDurationSeconds,
  HANDOFF_S,
  getHandoffFadeInCurve,
} from './crossfade.js';
import { createEffectsChain, connectChain, disconnectChain, resetEffectsChain } from './effects.js';
import { buildEffectsPanel } from './effects-ui.js';

// Shared AudioContext
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

// RAF handle
let rafId = null;

// Mix button reference
const mixBtn = document.getElementById('mix-btn');
const fadeBeatsInput = document.getElementById('fade-beats');
const fadeBeatsDisplay = document.getElementById('fade-beats-display');
const DEFAULT_FADE_BEATS = 8;
const BPM_INPUT_MIN = 40;
const BPM_INPUT_MAX = 240;

fadeBeatsInput.addEventListener('input', () => {
  fadeBeatsDisplay.textContent = fadeBeatsInput.value;
});

function getFadeBeats() {
  const raw = Number(fadeBeatsInput.value);
  const min = Number(fadeBeatsInput.min) || 2;
  const max = Number(fadeBeatsInput.max) || 32;

  if (!Number.isFinite(raw)) return DEFAULT_FADE_BEATS;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

//Beat grid from manual BPM; keeps phase anchored at first beat (same as detector grid phase)
function rebuildBeatGridKeepingAnchor(track, bpm) {
  const interval = 60 / bpm;
  const duration = track.buffer.duration;
  let anchor = track.beatTimes.length > 0 ? track.beatTimes[0] : 0;
  if (anchor >= duration) anchor = 0;

  const beatTimes = [];
  for (let t = anchor; t < duration; t += interval) {
    beatTimes.push(t);
  }
  track.beatTimes = beatTimes;
  track.bpm = Math.round(bpm * 10) / 10;
}

function redrawTrackFrame(track) {
  if (!track.buffer) return;
  let playheadTime = null;
  if (track.isPlaying && track.startContextTime != null) {
    const ctx = getAudioContext();
    const elapsed = Math.max(0, ctx.currentTime - track.startContextTime);
    playheadTime = track.startBufferTime + elapsed;
  }
  drawFrame(
    track.elements.canvas,
    track.buffer,
    track.beatTimes,
    track.cueTime,
    playheadTime,
    track.crossfadeRegion,
  );
}

function applyManualBpm(track) {
  if (!track.buffer) return;
  const input = track.elements.bpmInput;
  const raw = parseFloat(String(input.value).trim(), 10);
  if (!Number.isFinite(raw)) {
    input.value = track.bpm != null ? track.bpm.toFixed(1) : '';
    return;
  }
  const clamped = Math.max(BPM_INPUT_MIN, Math.min(BPM_INPUT_MAX, raw));
  const rounded = Math.round(clamped * 10) / 10;
  rebuildBeatGridKeepingAnchor(track, rounded);
  input.value = rounded.toFixed(1);
  redrawTrackFrame(track);
  updateMixBtn();
}

// Track state objects
const tracks = {
  a: makeTrack('a'),
  b: makeTrack('b'),
};

function makeTrack(id) {
  return {
    id,
    buffer: null,
    sourceNode: null,
    gainNode: null,
    analyserNode: null,
    isPlaying: false,
    bpm: null,
    beatTimes: [],
    cueTime: 0,
    startBufferTime: 0,
    startContextTime: null,
    crossfadeRegion: null,
    cueClickHandler: null,
    effectsChain: null,
    elements: {
      presetSelect: document.getElementById(`preset-${id}`),
      loadPresetBtn: document.getElementById(`load-preset-${id}`),
      uploadInput: document.getElementById(`upload-${id}`),
      bpmInput: document.getElementById(`bpm-input-${id}`),
      statusDisplay: document.getElementById(`status-${id}`),
      playBtn: document.getElementById(`play-${id}`),
      stopBtn: document.getElementById(`stop-${id}`),
      canvas: document.getElementById(`canvas-${id}`),
    },
  };
}

// Wire static events for both tracks
for (const track of Object.values(tracks)) {
  const el = track.elements;

  el.loadPresetBtn.addEventListener('click', () => {
    const url = el.presetSelect.value;
    if (!url) return;
    loadFromURL(track, url);
  });

  el.uploadInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    loadFromFile(track, file);
  });

  el.playBtn.addEventListener('click', () => playTrack(track));
  el.stopBtn.addEventListener('click', () => stopTrack(track));

  el.bpmInput.addEventListener('change', () => applyManualBpm(track));
  el.bpmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyManualBpm(track);
      el.bpmInput.blur();
    }
  });
}

function finishIncomingPlayback(track) {
  track.isPlaying = false;
  track.mixStopTargets = null;
  track.sourceNode = null;
  track.gainNode = null;
  track.analyserNode = null;
  track.startContextTime = null;
  track.elements.playBtn.disabled = false;
  track.elements.stopBtn.disabled = true;
  setStatus(track, 'Ready — click waveform to set cue');
  redrawTrackFrame(track);
  updateMixBtn();
  maybeStopLoop();
}

/** Resume incoming at `continuationOffset` after the crossfade, playbackRate 1, same gain chain.
 *  Uses a private contSourceFade node to micro-crossfade with the ending inSourceFade.
 *  Equal-power micro-fade over HANDOFF_S ends at fadeEndCtxTime − tailGapS (before PV tail silence).
 *
 *  stretchRate = masterBpm / incomingBpm (1.0 for the non-stretch path).
 *  The PV advances through the original buffer at stretchRate × wall-clock speed, so the
 *  buffer offset for the handoff must be scaled by stretchRate to avoid replaying audio the
 *  PV already covered. */
function scheduleIncomingContinuation(incoming, ctx, inGain, fadeEndCtxTime, continuationOffset, tailGapS = 0, stretchRate = 1) {
  const rampEndCtxTime = fadeEndCtxTime - tailGapS;
  const handoffCtxTime = rampEndCtxTime - HANDOFF_S;
  // The PV's original-time position at rampEndCtxTime is continuationOffset
  // not continuationOffset − tailGapS. Using the latter would replay audio
  const pvPositionAtRampEnd  = continuationOffset - tailGapS * stretchRate;
  const handoffBufferOffset  = Math.max(0, pvPositionAtRampEnd - HANDOFF_S);

  const contSourceFade = ctx.createGain();
  const contHandoffFadeIn = getHandoffFadeInCurve();
  contSourceFade.gain.setValueAtTime(0.0, handoffCtxTime);
  contSourceFade.gain.setValueCurveAtTime(contHandoffFadeIn, handoffCtxTime, HANDOFF_S);
  contSourceFade.connect(inGain);

  const contSource = ctx.createBufferSource();
  contSource.buffer = incoming.buffer;
  contSource.connect(contSourceFade);
  contSource.start(handoffCtxTime, handoffBufferOffset);

  contSource.onended = () => {
    if (incoming.sourceNode === contSource) {
      finishIncomingPlayback(incoming);
    }
  };

  const msUntilRampEnd = (rampEndCtxTime - ctx.currentTime) * 1000;
  setTimeout(() => {
    incoming.sourceNode = contSource;
    incoming.cueTime = pvPositionAtRampEnd;
    incoming.startBufferTime = pvPositionAtRampEnd;
    incoming.startContextTime = rampEndCtxTime;
  }, msUntilRampEnd + 50);
}

// After PV+dry dual blend: dry align source stops at `rampEndCtxTime`; continue dry buffer at playbackRate 1 from offset matching align playback
function schedulePvDryContinuation(
  incoming,
  ctx,
  inGain,
  rampEndCtxTime,
  dryBufferOffsetAtRampEnd,
  pvSource,
  dryAlignSource,
) {
  const tailEpsilon = 1e-4;
  const clampedOffset = Math.max(
    0,
    Math.min(dryBufferOffsetAtRampEnd, incoming.buffer.duration - tailEpsilon),
  );

  const contSource = ctx.createBufferSource();
  contSource.buffer = incoming.buffer;
  contSource.connect(inGain);
  contSource.start(rampEndCtxTime, clampedOffset);

  incoming.mixStopTargets = [pvSource, dryAlignSource, contSource];

  contSource.onended = () => {
    if (incoming.sourceNode === contSource) {
      finishIncomingPlayback(incoming);
    }
  };

  const msUntilRampEnd = (rampEndCtxTime - ctx.currentTime) * 1000;
  setTimeout(() => {
    incoming.sourceNode = contSource;
    incoming.cueTime = clampedOffset;
    incoming.startBufferTime = clampedOffset;
    incoming.startContextTime = rampEndCtxTime;
    incoming.mixStopTargets = [pvSource, contSource];
  }, msUntilRampEnd + 50);
}

// Mix button
mixBtn.addEventListener('click', async () => {
  const master = getPlayingTrack();
  const incoming = getIdleTrack();
  if (!master || !incoming || !incoming.buffer) return;

  mixBtn.disabled = true;
  const ctx = getAudioContext();

  const fadeBeats = getFadeBeats();
  const fadeDuration = getFadeDurationSeconds(master.bpm, fadeBeats);
  let stretchedBuffer = null;
  let sourceAdvance;
  let stretchedTailS = 0;

  if (needsTimeStretch(master.bpm, incoming.bpm)) {
    sourceAdvance = fadeDuration * master.bpm / incoming.bpm;

    const slice = extractSegment(incoming.buffer, incoming.cueTime, sourceAdvance, ctx);

    setMixStatus('Preparing mix…');
    try {
      stretchedBuffer = await timeStretchBuffer(slice, master.bpm, incoming.bpm, ctx);
      stretchedBuffer = trimBufferToWallClock(ctx, stretchedBuffer, fadeDuration);
      stretchedBuffer = clipBuffer(stretchedBuffer);
      stretchedTailS = measureTailSilence(stretchedBuffer);
    } catch (err) {
      setMixStatus(`Stretch error: ${err.message}`);
      mixBtn.disabled = false;
      return;
    }
  } else {
    sourceAdvance = fadeDuration * computePlaybackRate(master.bpm, incoming.bpm);
  }

  const continuationOffset = incoming.cueTime + sourceAdvance;

  // Tail-gap: PV output often ends with trailing silence (length varies by BPM ratio,
  // worklet vs pure-JS, browser). measureTailSilence scans the actual buffer; add a
  // small margin so the stretch branch fades out before that silence while continuation
  // ramps up. Cap so rampEnd stays inside the fade window
  const TAIL_MARGIN_S = 0.027;
  const maxTailGapS = Math.max(0, fadeDuration - HANDOFF_S);
  const tailGapS = stretchedBuffer
    ? Math.min(stretchedTailS + TAIL_MARGIN_S, maxTailGapS)
    : 0;
  // stretchRate: how fast the PV advances through the original buffer relative to wall clock
  // Used to position contSource so it picks up exactly where the PV left off
  const stretchRate = stretchedBuffer ? master.bpm / incoming.bpm : 1;

  // Re-validate master after the async stretch — it may have ended during processing
  if (!master.isPlaying || !master.gainNode || !master.sourceNode) {
    setMixStatus('Master track ended during preparation');
    mixBtn.disabled = false;
    return;
  }

  let result;
  try {
    result = scheduleMix(master, incoming, ctx, stretchedBuffer, fadeBeats, tailGapS);
  } catch (err) {
    setMixStatus(`Schedule error: ${err.message}`);
    mixBtn.disabled = false;
    return;
  }

  if (!result) {
    setMixStatus('No upcoming downbeat found');
    mixBtn.disabled = false;
    return;
  }

  const {
    nextDownbeatCtxTime,
    nextDownbeatBufferTime,
    fadeDuration: scheduledFade,
    inSource,
    inGain,
    dryAlignSource,
  } = result;
  const fadeEndCtxTime = nextDownbeatCtxTime + scheduledFade;
  const rampEndCtxTime = fadeEndCtxTime - tailGapS;

  // Wire AnalyserNode for the incoming track, routing through its effects chain if present
  const inAnalyser = ctx.createAnalyser();
  inAnalyser.fftSize = 2048;
  inAnalyser.connect(ctx.destination);
  inGain.disconnect();
  if (incoming.effectsChain) {
    connectChain(incoming.effectsChain, inGain, inAnalyser);
  } else {
    inGain.connect(inAnalyser);
  }

  const tailEpsilon = 1e-4;
  if (continuationOffset < incoming.buffer.duration - tailEpsilon) {
    if (dryAlignSource) {
      // Match crossfade dryAlign playbackRate (true BPM ratio, not computePlaybackRate clamp)
      // Derive elapsed from scheduled fade and tailGap so it matches rampEnd math as best as we can
      const alignRate = playbackRateForPvDryAlign(master.bpm, incoming.bpm);
      const elapsedBlend = scheduledFade - tailGapS;
      const dryBufferOffsetAtRampEnd = snapBufferOffset(
        incoming.buffer,
        incoming.cueTime + elapsedBlend * alignRate,
      );
      schedulePvDryContinuation(
        incoming,
        ctx,
        inGain,
        rampEndCtxTime,
        dryBufferOffsetAtRampEnd,
        inSource,
        dryAlignSource,
      );
    } else {
      scheduleIncomingContinuation(incoming, ctx, inGain, fadeEndCtxTime, continuationOffset, tailGapS, stretchRate);
      incoming.mixStopTargets = null;
    }
  } else {
    incoming.mixStopTargets = dryAlignSource ? [inSource, dryAlignSource] : null;
    inSource.onended = () => {
      if (incoming.sourceNode === inSource) {
        finishIncomingPlayback(incoming);
      }
    };
  }

  // Mark master's crossfade region for the visualizer
  master.crossfadeRegion = {
    start: nextDownbeatBufferTime,
    end: nextDownbeatBufferTime + scheduledFade,
  };

  // Update incoming track state so RAF loop animates its playhead
  incoming.sourceNode = inSource;
  incoming.gainNode = inGain;
  incoming.analyserNode = inAnalyser;
  incoming.isPlaying = true;
  incoming.startBufferTime = incoming.cueTime;
  incoming.startContextTime = nextDownbeatCtxTime;
  incoming.elements.playBtn.disabled = true;
  incoming.elements.stopBtn.disabled = false;
  setStatus(incoming, 'Playing');

  setMixStatus('Mixing…');
  startLoop();

  // After the fade completes, clean up master and rewire incoming effects chain
  const msUntilEnd = (fadeEndCtxTime - ctx.currentTime) * 1000;
  setTimeout(() => {
    disconnectChain(master.effectsChain);
    master.isPlaying = false;
    master.sourceNode = null;
    master.gainNode = null;
    master.analyserNode = null;
    master.startContextTime = null;
    master.crossfadeRegion = null;
    master.elements.playBtn.disabled = false;
    master.elements.stopBtn.disabled = true;
    setStatus(master, 'Ready — click waveform to set cue');
    redrawTrackFrame(master);

    setMixStatus('');
    updateMixBtn();
    maybeStopLoop();
  }, msUntilEnd + 50);
});

// Fetch a URL and decode to AudioBuffer
async function loadFromURL(track, url) {
  setStatus(track, 'Loading…');
  try {
    const response = await fetch(encodeURI(url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    await decodeAndReady(track, arrayBuffer);
  } catch (err) {
    setStatus(track, `Error: ${err.message}`);
  }
}

// Read a File and decode to AudioBuffer
async function loadFromFile(track, file) {
  setStatus(track, 'Reading…');
  try {
    const arrayBuffer = await file.arrayBuffer();
    await decodeAndReady(track, arrayBuffer);
  } catch (err) {
    setStatus(track, `Error: ${err.message}`);
  }
}

// Decode an ArrayBuffer to an AudioBuffer, then hand off to onBufferReady
async function decodeAndReady(track, arrayBuffer) {
  setStatus(track, 'Decoding…');
  const ctx = getAudioContext();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    await onBufferReady(track, audioBuffer);
  } catch (err) {
    setStatus(track, `Decode error: ${err.message}`);
  }
}

// Called once an AudioBuffer is ready: analyze, visualize, enable controls
async function onBufferReady(track, audioBuffer) {
  if (track.isPlaying) stopTrack(track);

  track.buffer = audioBuffer;
  track.cueTime = 0;
  track.crossfadeRegion = null;
  setStatus(track, 'Analyzing BPM…');

  const { bpm, beatTimes } = await detectBPM(audioBuffer);
  track.bpm = bpm;
  track.beatTimes = beatTimes;
  track.elements.bpmInput.disabled = false;
  track.elements.bpmInput.value = bpm.toFixed(1);

  redrawTrackFrame(track);

  // Create effects chain on first load; reset audio params and rebuild panel DOM on every load
  const fxCtx = getAudioContext();
  if (!track.effectsChain) {
    track.effectsChain = createEffectsChain(fxCtx);
  } else {
    resetEffectsChain(track.effectsChain, fxCtx);
  }
  const panel = buildEffectsPanel(track.id, track.effectsChain, fxCtx);
  document.getElementById(`effects-rack-${track.id}`).replaceChildren(panel);

  attachCueClickHandler(track);

  track.elements.playBtn.disabled = false;
  track.elements.stopBtn.disabled = true;
  setStatus(track, 'Ready — click waveform to set cue');
  updateMixBtn();
}

// Replace the canvas click listener each time a new buffer is loaded
function attachCueClickHandler(track) {
  const canvas = track.elements.canvas;

  if (track.cueClickHandler) {
    canvas.removeEventListener('click', track.cueClickHandler);
  }

  track.cueClickHandler = (e) => {
    const scaleX = canvas.width / canvas.getBoundingClientRect().width;
    const cueTime = (e.offsetX * scaleX / canvas.width) * track.buffer.duration;
    track.cueTime = Math.max(0, Math.min(cueTime, track.buffer.duration - 0.01));
    redrawTrackFrame(track);
  };

  canvas.addEventListener('click', track.cueClickHandler);
  canvas.style.cursor = 'crosshair';
}

// Build the audio graph for a track: source -> gain -> [effects] -> analyser -> destination
function buildAudioGraph(ctx, track) {
  const gainNode = ctx.createGain();
  gainNode.gain.setValueAtTime(1.0, ctx.currentTime);

  const analyserNode = ctx.createAnalyser();
  analyserNode.fftSize = 2048;
  analyserNode.connect(ctx.destination);

  if (track.effectsChain) {
    connectChain(track.effectsChain, gainNode, analyserNode);
  } else {
    gainNode.connect(analyserNode);
  }

  track.gainNode = gainNode;
  track.analyserNode = analyserNode;
}

// Start playback: AudioBufferSourceNode -> GainNode -> AnalyserNode -> destination
function playTrack(track) {
  if (!track.buffer || track.isPlaying) return;

  const ctx = getAudioContext();

  buildAudioGraph(ctx, track);

  const sourceNode = ctx.createBufferSource();
  sourceNode.buffer = track.buffer;

  // BPM alignment: if the other track is already playing, this is the incoming track
  const other = otherTrack(track);
  if (other.isPlaying && other.bpm && track.bpm) {
    sourceNode.playbackRate.value = computePlaybackRate(other.bpm, track.bpm);
  }

  sourceNode.connect(track.gainNode);
  sourceNode.start(0, track.cueTime);
  track.startBufferTime = track.cueTime;
  track.startContextTime = ctx.currentTime;

  sourceNode.onended = () => {
    if (track.sourceNode === sourceNode) {
      track.isPlaying = false;
      track.sourceNode = null;
      track.gainNode = null;
      track.analyserNode = null;
      track.startContextTime = null;
      track.elements.playBtn.disabled = false;
      track.elements.stopBtn.disabled = true;
      setStatus(track, 'Ready — click waveform to set cue');
      redrawTrackFrame(track);
      updateMixBtn();
      maybeStopLoop();
    }
  };

  track.sourceNode = sourceNode;
  track.isPlaying = true;

  track.elements.playBtn.disabled = true;
  track.elements.stopBtn.disabled = false;
  setStatus(track, 'Playing');
  updateMixBtn();
  startLoop();
}

// Stop playback: ramp gain to 0 before calling stop 
function stopTrack(track) {
  if (!track.isPlaying || !track.sourceNode) return;

  const ctx = getAudioContext();
  const { gainNode, sourceNode } = track;

  gainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.01);

  const stopTargets = track.mixStopTargets?.length ? track.mixStopTargets : [sourceNode];
  track.mixStopTargets = null;
  for (const s of stopTargets) {
    try {
      s.stop(ctx.currentTime + 0.1);
    } catch (_) {
      /* already stopped */
    }
  }

  // Disconnect effects chain after the source has gone silent
  if (track.effectsChain) {
    setTimeout(() => disconnectChain(track.effectsChain), 150);
  }

  track.isPlaying = false;
  track.sourceNode = null;
  track.gainNode = null;
  track.analyserNode = null;
  track.startContextTime = null;
  track.crossfadeRegion = null;

  track.elements.playBtn.disabled = false;
  track.elements.stopBtn.disabled = true;
  setStatus(track, 'Ready — click waveform to set cue');

  if (track.buffer) {
    redrawTrackFrame(track);
  }

  updateMixBtn();
  maybeStopLoop();
}

// RAF loop
function animationLoop() {
  for (const track of Object.values(tracks)) {
    if (!track.isPlaying || !track.buffer) continue;
    redrawTrackFrame(track);
  }

  rafId = requestAnimationFrame(animationLoop);
}

function startLoop() {
  if (rafId === null) {
    rafId = requestAnimationFrame(animationLoop);
  }
}

function maybeStopLoop() {
  const anyPlaying = Object.values(tracks).some((t) => t.isPlaying);
  if (!anyPlaying && rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function getPlayingTrack() {
  return Object.values(tracks).find((t) => t.isPlaying) ?? null;
}

function getIdleTrack() {
  return Object.values(tracks).find((t) => !t.isPlaying) ?? null;
}

function updateMixBtn() {
  const master = getPlayingTrack();
  const incoming = getIdleTrack();
  mixBtn.disabled = !(master && incoming && incoming.buffer);
}

function otherTrack(track) {
  return track.id === 'a' ? tracks.b : tracks.a;
}

function setStatus(track, message) {
  track.elements.statusDisplay.textContent = message;
}

function setMixStatus(msg) {
  document.getElementById('mix-status').textContent = msg;
  const dot = document.getElementById('mix-dot');
  dot.className = 'status-dot';
  if (msg === 'Mixing…') dot.classList.add('mixing');
  else if (msg === '') { /* hidden */ }
  else dot.classList.add('ready');
}
