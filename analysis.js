/**
 * Detects the BPM of an AudioBuffer and computes the beat grid.
 * Algorithm: amplitude envelope → onset signal (first-order diff + threshold)
 * → autocorrelation over lags for 60–180 BPM → peak pick → beat timestamps.
 *
 * @param {AudioBuffer} audioBuffer
 * @returns {Promise<{ bpm: number, beatTimes: number[] }>}
 */
export async function detectBPM(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const envelope = buildEnvelope(audioBuffer);
  const { onsets, threshold } = buildOnsetSignal(envelope);
  const bpm = autocorrelationBPM(onsets, sampleRate);
  const beatTimes = buildBeatGrid(bpm, onsets, threshold, sampleRate, audioBuffer.duration);
  return { bpm, beatTimes };
}

// Downmix all channels to mono and take absolute value.
function buildEnvelope(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const envelope = new Float32Array(length);

  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      envelope[i] += Math.abs(data[i]);
    }
  }

  const scale = 1 / numChannels;
  for (let i = 0; i < length; i++) {
    envelope[i] *= scale;
  }

  return envelope;
}

// First-order difference of envelope, keep only positive rises, then threshold.
// Returns both the onset signal and the threshold value (needed for beat grid anchoring).
function buildOnsetSignal(envelope) {
  const onsets = new Float32Array(envelope.length);
  let max = 0;

  for (let i = 1; i < envelope.length; i++) {
    const diff = envelope[i] - envelope[i - 1];
    onsets[i] = diff > 0 ? diff : 0;
    if (onsets[i] > max) max = onsets[i];
  }

  const threshold = max * 0.1;
  for (let i = 0; i < onsets.length; i++) {
    if (onsets[i] < threshold) onsets[i] = 0;
  }

  return { onsets, threshold };
}

// Build an array of beat timestamps (in seconds) anchored to the first strong onset.
function buildBeatGrid(bpm, onsets, threshold, sampleRate, duration) {
  const beatInterval = 60 / bpm;

  // Find the first sample that exceeds the threshold in the original (non-decimated) onset signal.
  let firstBeat = 0;
  for (let i = 0; i < onsets.length; i++) {
    if (onsets[i] >= threshold) {
      firstBeat = i / sampleRate;
      break;
    }
  }

  const beatTimes = [];
  for (let t = firstBeat; t < duration; t += beatInterval) {
    beatTimes.push(t);
  }
  return beatTimes;
}

// Autocorrelation over lags corresponding to 60–180 BPM.
// Downsamples to a reduced rate first so autocorrelation is fast.
function autocorrelationBPM(onsets, sampleRate) {
  // Downsample to ~200 Hz for speed — onset signal doesn't need full resolution.
  const decimation = Math.floor(sampleRate / 200);
  const decimated = downsample(onsets, decimation);
  const reducedRate = sampleRate / decimation;

  const lagMin = Math.floor(reducedRate * 60 / 180); // lag for 180 BPM
  const lagMax = Math.floor(reducedRate * 60 / 60);  // lag for 60 BPM
  const n = decimated.length;

  let bestLag = lagMin;
  let bestCorr = -Infinity;

  for (let lag = lagMin; lag <= lagMax; lag++) {
    let corr = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) {
      corr += decimated[i] * decimated[i + lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  // Octave-correction: songs with strong 8th-note patterns often score higher at
  // the half-beat lag (2× BPM) than the true beat lag. If doubling the lag
  // (halving the BPM) is still within the valid range and scores ≥ 80% of the
  // best correlation, the detected tempo is almost certainly a 2× harmonic error
  // — prefer the lower, more likely fundamental tempo.
  const doubleLag = bestLag * 2;
  if (doubleLag <= lagMax) {
    let doubleCorr = 0;
    const limit = n - doubleLag;
    for (let i = 0; i < limit; i++) {
      doubleCorr += decimated[i] * decimated[i + doubleLag];
    }
    if (doubleCorr >= bestCorr * 0.8) {
      bestLag = doubleLag;
    }
  }

  const bpm = (reducedRate * 60) / bestLag;
  return Math.round(bpm * 10) / 10;
}

function downsample(signal, factor) {
  const out = new Float32Array(Math.floor(signal.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) {
      sum += signal[base + j];
    }
    out[i] = sum / factor;
  }
  return out;
}
