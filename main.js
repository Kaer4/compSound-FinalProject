import { detectBPM } from './analysis.js';
import { drawFrame } from './visualizer.js';
import { computePlaybackRate, needsTimeStretch, timeStretchBuffer, extractSegment } from './alignment.js';
import { scheduleMix } from './crossfade.js';

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

// Mix button.
mixBtn.addEventListener('click', async () => {
  const master = getPlayingTrack();
  const incoming = getIdleTrack();
  if (!master || !incoming || !incoming.buffer) return;

  mixBtn.disabled = true;
  const ctx = getAudioContext();

  // Phase vocoder pre-processing — only stretch the crossfade window, not the whole track.
  let stretchedBuffer    = null;
  let continuationOffset = incoming.cueTime; // where original buffer resumes after crossfade

  if (needsTimeStretch(master.bpm, incoming.bpm)) {
    const stretchFactor  = incoming.bpm / master.bpm;
    const fadeDuration   = 8 * (60 / master.bpm);       // crossfade window in seconds
    const sourceDuration = fadeDuration / stretchFactor; // seconds of original consumed

    // Extract just the crossfade slice — ~4–8 seconds instead of the whole track.
    const slice = extractSegment(incoming.buffer, incoming.cueTime, sourceDuration, ctx);

    setMixStatus('Preparing mix…');
    try {
      stretchedBuffer = await timeStretchBuffer(slice, master.bpm, incoming.bpm, ctx);
    } catch (err) {
      setMixStatus(`Stretch error: ${err.message}`);
      mixBtn.disabled = false;
      return;
    }

    continuationOffset = incoming.cueTime + sourceDuration;
  }

  // Re-validate master after the async stretch — it may have ended during processing.
  if (!master.isPlaying || !master.gainNode || !master.sourceNode) {
    setMixStatus('Master track ended during preparation');
    mixBtn.disabled = false;
    return;
  }

  let result;
  try {
    result = scheduleMix(master, incoming, ctx, stretchedBuffer);
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

  const { nextDownbeatCtxTime, nextDownbeatBufferTime, fadeDuration, inSource, inGain } = result;

  // Wire AnalyserNode for the incoming track.
  const inAnalyser = ctx.createAnalyser();
  inAnalyser.fftSize = 2048;
  inGain.disconnect();
  inGain.connect(inAnalyser);
  inAnalyser.connect(ctx.destination);

  // If we stretched a slice, schedule the original buffer to resume seamlessly after the
  // crossfade ends — same gain/analyser chain, no audible gap.
  if (stretchedBuffer && continuationOffset < incoming.buffer.duration) {
    const contSource = ctx.createBufferSource();
    contSource.buffer = incoming.buffer;
    contSource.connect(inGain);
    contSource.start(nextDownbeatCtxTime + fadeDuration, continuationOffset);

    contSource.onended = () => {
      if (incoming.sourceNode === contSource) {
        incoming.isPlaying = false;
        incoming.sourceNode = null;
        incoming.gainNode = null;
        incoming.analyserNode = null;
        incoming.startContextTime = null;
        incoming.elements.playBtn.disabled = false;
        incoming.elements.stopBtn.disabled = true;
        setStatus(incoming, 'Ready — click waveform to set cue');
        drawFrame(incoming.elements.canvas, incoming.buffer, incoming.beatTimes, incoming.cueTime, null, null);
        updateMixBtn();
        maybeStopLoop();
      }
    };

    // After the crossfade window, hand off the sourceNode reference to the continuation
    // and fix startContextTime so the playhead tracks the original buffer correctly.
    const msUntilContinuation = (nextDownbeatCtxTime + fadeDuration - ctx.currentTime) * 1000;
    setTimeout(() => {
      incoming.sourceNode       = contSource;
      incoming.cueTime          = continuationOffset;
      incoming.startContextTime = nextDownbeatCtxTime + fadeDuration;
    }, msUntilContinuation + 50);
  }

  // Mark master's crossfade region for the visualizer.
  master.crossfadeRegion = {
    start: nextDownbeatBufferTime,
    end: nextDownbeatBufferTime + fadeDuration,
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

  // After the fade completes, clean up master state.
  const msUntilEnd = (nextDownbeatCtxTime + fadeDuration - ctx.currentTime) * 1000;
  setTimeout(() => {
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
    setMixStatus('');
    updateMixBtn();
    maybeStopLoop();
  }, msUntilEnd + 50);
});

// Fetch a URL and decode to AudioBuffer.
async function loadFromURL(track, url) {
  setStatus(track, 'Loading…');
  try {
    const response = await fetch(url);
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

// Build the audio graph for a track: source → gain → analyser → destination.
function buildAudioGraph(ctx, track) {
  const gainNode = ctx.createGain();
  gainNode.gain.setValueAtTime(1.0, ctx.currentTime);

  const analyserNode = ctx.createAnalyser();
  analyserNode.fftSize = 2048;

  gainNode.connect(analyserNode);
  analyserNode.connect(ctx.destination);

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
}
