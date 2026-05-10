import { detectBPM } from './analysis.js';
import { drawFrame } from './visualizer.js';
import { computePlaybackRate, needsTimeStretch, timeStretchBuffer, extractSegment, trimBufferToWallClock } from './alignment.js';
import { scheduleMix, getFadeDurationSeconds, HANDOFF_S } from './crossfade.js';
import { createEffectsChain, connectChain, disconnectChain, resetEffectsChain } from './effects.js';
import { buildEffectsPanel } from './effects-ui.js';

// Shared AudioContext — created lazily on first user gesture.
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

// RAF handle — single loop drives both canvases.
let rafId = null;

// Mix button reference.
const mixBtn = document.getElementById('mix-btn');
const fadeBeatsInput = document.getElementById('fade-beats');
const fadeBeatsDisplay = document.getElementById('fade-beats-display');
const DEFAULT_FADE_BEATS = 8;

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

// Track state objects.
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
    startContextTime: null,
    crossfadeRegion: null,
    cueClickHandler: null,
    effectsChain: null,
    elements: {
      presetSelect: document.getElementById(`preset-${id}`),
      loadPresetBtn: document.getElementById(`load-preset-${id}`),
      uploadInput: document.getElementById(`upload-${id}`),
      bpmDisplay: document.getElementById(`bpm-${id}`),
      statusDisplay: document.getElementById(`status-${id}`),
      playBtn: document.getElementById(`play-${id}`),
      stopBtn: document.getElementById(`stop-${id}`),
      canvas: document.getElementById(`canvas-${id}`),
    },
  };
}

// Wire static events for both tracks.
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
}

function finishIncomingPlayback(track) {
  track.isPlaying = false;
  track.sourceNode = null;
  track.gainNode = null;
  track.analyserNode = null;
  track.startContextTime = null;
  track.elements.playBtn.disabled = false;
  track.elements.stopBtn.disabled = true;
  setStatus(track, 'Ready — click waveform to set cue');
  drawFrame(track.elements.canvas, track.buffer, track.beatTimes, track.cueTime, null, null);
  updateMixBtn();
  maybeStopLoop();
}

/** Resume incoming at `continuationOffset` after the crossfade, playbackRate 1, same gain chain.
 *  Uses a private contSourceFade node to micro-crossfade with the ending inSourceFade. */
function scheduleIncomingContinuation(incoming, ctx, inGain, fadeEndCtxTime, continuationOffset) {
  const handoffCtxTime    = fadeEndCtxTime - HANDOFF_S;
  const handoffBufferOffset = Math.max(0, continuationOffset - HANDOFF_S);

  // Private gain node: ramps 0→1 over HANDOFF_S, overlapping with inSourceFade's 1→0 ramp.
  const contSourceFade = ctx.createGain();
  contSourceFade.gain.setValueAtTime(0.0, handoffCtxTime);
  contSourceFade.gain.linearRampToValueAtTime(1.0, fadeEndCtxTime);
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

  const msUntilHandoff = (fadeEndCtxTime - ctx.currentTime) * 1000;
  setTimeout(() => {
    incoming.sourceNode = contSource;
    incoming.cueTime = continuationOffset;
    incoming.startContextTime = fadeEndCtxTime;
  }, msUntilHandoff + 50);
}

// Mix button.
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

  if (needsTimeStretch(master.bpm, incoming.bpm)) {
    sourceAdvance = fadeDuration * master.bpm / incoming.bpm;

    const slice = extractSegment(incoming.buffer, incoming.cueTime, sourceAdvance, ctx);

    setMixStatus('Preparing mix…');
    try {
      stretchedBuffer = await timeStretchBuffer(slice, master.bpm, incoming.bpm, ctx);
      stretchedBuffer = trimBufferToWallClock(ctx, stretchedBuffer, fadeDuration);
    } catch (err) {
      setMixStatus(`Stretch error: ${err.message}`);
      mixBtn.disabled = false;
      return;
    }
  } else {
    sourceAdvance = fadeDuration * computePlaybackRate(master.bpm, incoming.bpm);
  }

  const continuationOffset = incoming.cueTime + sourceAdvance;

  // Re-validate master after the async stretch — it may have ended during processing.
  if (!master.isPlaying || !master.gainNode || !master.sourceNode) {
    setMixStatus('Master track ended during preparation');
    mixBtn.disabled = false;
    return;
  }

  let result;
  try {
    result = scheduleMix(master, incoming, ctx, stretchedBuffer, fadeBeats);
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

  const { nextDownbeatCtxTime, nextDownbeatBufferTime, fadeDuration: scheduledFade, inSource, inGain, masterHPF } = result;
  const fadeEndCtxTime = nextDownbeatCtxTime + scheduledFade;

  // Wire AnalyserNode for the incoming track.
  const inAnalyser = ctx.createAnalyser();
  inAnalyser.fftSize = 2048;
  inGain.disconnect();
  inGain.connect(inAnalyser);
  inAnalyser.connect(ctx.destination);

  const tailEpsilon = 1e-4;
  if (continuationOffset < incoming.buffer.duration - tailEpsilon) {
    scheduleIncomingContinuation(incoming, ctx, inGain, fadeEndCtxTime, continuationOffset);
  } else {
    inSource.onended = () => {
      if (incoming.sourceNode === inSource) {
        finishIncomingPlayback(incoming);
      }
    };
  }

  // Mark master's crossfade region for the visualizer.
  master.crossfadeRegion = {
    start: nextDownbeatBufferTime,
    end: nextDownbeatBufferTime + scheduledFade,
  };

  // Update incoming track state so RAF loop animates its playhead.
  incoming.sourceNode = inSource;
  incoming.gainNode = inGain;
  incoming.analyserNode = inAnalyser;
  incoming.isPlaying = true;
  incoming.startContextTime = nextDownbeatCtxTime;
  incoming.elements.playBtn.disabled = true;
  incoming.elements.stopBtn.disabled = false;
  setStatus(incoming, 'Playing');

  setMixStatus('Mixing…');
  startLoop();

  // After the fade completes, clean up master and rewire incoming effects chain.
  const msUntilEnd = (fadeEndCtxTime - ctx.currentTime) * 1000;
  setTimeout(() => {
    masterHPF.disconnect();
    // Disconnect master effects chain — its gainNode was already rerouted in scheduleMix.
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
    drawFrame(master.elements.canvas, master.buffer, master.beatTimes, master.cueTime, null, null);

    // Rewire incoming effects chain now that the crossfade is done.
    // During the fade, inGain → inAnalyser was direct. Insert the chain between them.
    if (incoming.effectsChain && incoming.gainNode && incoming.analyserNode) {
      incoming.gainNode.disconnect(incoming.analyserNode);
      connectChain(incoming.effectsChain, incoming.gainNode, incoming.analyserNode);
    }

    setMixStatus('');
    updateMixBtn();
    maybeStopLoop();
  }, msUntilEnd + 50);
});

// Fetch a URL and decode to AudioBuffer.
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

// Read a File and decode to AudioBuffer.
async function loadFromFile(track, file) {
  setStatus(track, 'Reading…');
  try {
    const arrayBuffer = await file.arrayBuffer();
    await decodeAndReady(track, arrayBuffer);
  } catch (err) {
    setStatus(track, `Error: ${err.message}`);
  }
}

// Decode an ArrayBuffer to an AudioBuffer, then hand off to onBufferReady.
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

// Called once an AudioBuffer is ready: analyze, visualize, enable controls.
async function onBufferReady(track, audioBuffer) {
  if (track.isPlaying) stopTrack(track);

  track.buffer = audioBuffer;
  track.cueTime = 0;
  track.crossfadeRegion = null;
  setStatus(track, 'Analyzing BPM…');

  const { bpm, beatTimes } = await detectBPM(audioBuffer);
  track.bpm = bpm;
  track.beatTimes = beatTimes;
  track.elements.bpmDisplay.textContent = bpm.toFixed(1);

  drawFrame(track.elements.canvas, audioBuffer, beatTimes, track.cueTime, null, null);

  // Create effects chain on first load; reset audio params and rebuild panel DOM on every load.
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

// Replace the canvas click listener each time a new buffer is loaded.
function attachCueClickHandler(track) {
  const canvas = track.elements.canvas;

  if (track.cueClickHandler) {
    canvas.removeEventListener('click', track.cueClickHandler);
  }

  track.cueClickHandler = (e) => {
    const scaleX = canvas.width / canvas.getBoundingClientRect().width;
    const cueTime = (e.offsetX * scaleX / canvas.width) * track.buffer.duration;
    track.cueTime = Math.max(0, Math.min(cueTime, track.buffer.duration - 0.01));
    drawFrame(canvas, track.buffer, track.beatTimes, track.cueTime, null, track.crossfadeRegion);
  };

  canvas.addEventListener('click', track.cueClickHandler);
  canvas.style.cursor = 'crosshair';
}

// Build the audio graph for a track: source → gain → [effects] → analyser → destination.
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

// Start playback: AudioBufferSourceNode → GainNode → AnalyserNode → destination.
function playTrack(track) {
  if (!track.buffer || track.isPlaying) return;

  const ctx = getAudioContext();

  buildAudioGraph(ctx, track);

  const sourceNode = ctx.createBufferSource();
  sourceNode.buffer = track.buffer;

  // BPM alignment: if the other track is already playing, this is the incoming track.
  const other = otherTrack(track);
  if (other.isPlaying && other.bpm && track.bpm) {
    sourceNode.playbackRate.value = computePlaybackRate(other.bpm, track.bpm);
  }

  sourceNode.connect(track.gainNode);
  sourceNode.start(0, track.cueTime);
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
      drawFrame(track.elements.canvas, track.buffer, track.beatTimes, track.cueTime, null, null);
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

// Stop playback: ramp gain to 0 before calling stop (never cut at non-zero amplitude).
function stopTrack(track) {
  if (!track.isPlaying || !track.sourceNode) return;

  const ctx = getAudioContext();
  const { gainNode, sourceNode } = track;

  gainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
  sourceNode.stop(ctx.currentTime + 0.1);

  // Disconnect effects chain after the source has gone silent.
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
    drawFrame(track.elements.canvas, track.buffer, track.beatTimes, track.cueTime, null, null);
  }

  updateMixBtn();
  maybeStopLoop();
}

// RAF loop — updates playhead for every playing track each frame.
function animationLoop() {
  const ctx = getAudioContext();

  for (const track of Object.values(tracks)) {
    if (!track.isPlaying || !track.buffer) continue;
    const elapsed = Math.max(0, ctx.currentTime - track.startContextTime);
    const playheadTime = track.cueTime + elapsed;
    drawFrame(
      track.elements.canvas,
      track.buffer,
      track.beatTimes,
      track.cueTime,
      playheadTime,
      track.crossfadeRegion,
    );
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
