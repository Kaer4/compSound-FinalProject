/**
 * Draws the full canvas frame: waveform, beat grid, cue marker, playhead.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {AudioBuffer} audioBuffer
 * @param {number[]} beatTimes  - beat timestamps in seconds; pass [] if not ready
 * @param {number|null} cueTime - cue point in seconds; pass null to skip
 * @param {number|null} playheadTime - current playback position in seconds; pass null when stopped
 */
/**
 * @param {HTMLCanvasElement} canvas
 * @param {AudioBuffer} audioBuffer
 * @param {number[]} beatTimes       - beat timestamps in seconds; [] if not ready
 * @param {number|null} cueTime      - cue point in seconds; null to skip
 * @param {number|null} playheadTime - playback position in seconds; null when stopped
 * @param {{ start: number, end: number }|null} crossfadeRegion - buffer-time range to highlight; null to skip
 */
export function drawFrame(canvas, audioBuffer, beatTimes, cueTime, playheadTime, crossfadeRegion = null) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const duration = audioBuffer.duration;

  ctx.clearRect(0, 0, width, height);

  drawWaveform(ctx, width, height, audioBuffer);
  if (crossfadeRegion) drawCrossfadeRegion(ctx, width, height, crossfadeRegion, duration);
  drawBeatGrid(ctx, width, height, beatTimes, duration);
  if (cueTime !== null) drawCueMarker(ctx, width, height, cueTime, duration);
  if (playheadTime !== null) drawPlayhead(ctx, width, height, playheadTime, duration);
}

function drawWaveform(ctx, width, height, audioBuffer) {
  const mid = height / 2;
  const mono = toMono(audioBuffer);
  const samplesPerPixel = Math.floor(mono.length / width);

  ctx.beginPath();
  ctx.strokeStyle = '#7cf';
  ctx.lineWidth = 1;

  for (let x = 0; x < width; x++) {
    const start = x * samplesPerPixel;
    let min = 0;
    let max = 0;

    for (let s = start; s < start + samplesPerPixel && s < mono.length; s++) {
      const v = mono[s];
      if (v < min) min = v;
      if (v > max) max = v;
    }

    const yTop = mid - max * mid;
    const yBot = mid - min * mid;

    ctx.moveTo(x, yTop);
    ctx.lineTo(x, yBot);
  }

  ctx.stroke();
}

function drawCrossfadeRegion(ctx, width, height, region, duration) {
  const x1 = (region.start / duration) * width;
  const x2 = (region.end / duration) * width;
  ctx.fillStyle = 'rgba(255, 140, 0, 0.18)';
  ctx.fillRect(x1, 0, x2 - x1, height);
}

function drawBeatGrid(ctx, width, height, beatTimes, duration) {
  if (!beatTimes.length) return;

  for (let i = 0; i < beatTimes.length; i++) {
    const x = Math.round((beatTimes[i] / duration) * width);
    const isDownbeat = i % 4 === 0;

    ctx.beginPath();
    ctx.strokeStyle = isDownbeat ? 'rgba(255,255,100,0.6)' : 'rgba(255,255,100,0.25)';
    ctx.lineWidth = isDownbeat ? 1.5 : 1;
    // Downbeats reach full height; off-beats are shorter (middle 60%)
    const yStart = isDownbeat ? 0 : height * 0.2;
    const yEnd = isDownbeat ? height : height * 0.8;
    ctx.moveTo(x, yStart);
    ctx.lineTo(x, yEnd);
    ctx.stroke();
  }
}

function drawCueMarker(ctx, width, height, cueTime, duration) {
  const x = Math.round((cueTime / duration) * width);

  ctx.beginPath();
  ctx.strokeStyle = '#0f0';
  ctx.lineWidth = 2;
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();

  // Small downward triangle above the line.
  ctx.beginPath();
  ctx.fillStyle = '#0f0';
  ctx.moveTo(x - 5, 0);
  ctx.lineTo(x + 5, 0);
  ctx.lineTo(x, 8);
  ctx.closePath();
  ctx.fill();
}

function drawPlayhead(ctx, width, height, playheadTime, duration) {
  const x = Math.round((playheadTime / duration) * width);

  ctx.beginPath();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}

// Average all channels into a single mono Float32Array.
function toMono(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += data[i];
    }
  }

  const scale = 1 / numChannels;
  for (let i = 0; i < length; i++) {
    mono[i] *= scale;
  }

  return mono;
}
