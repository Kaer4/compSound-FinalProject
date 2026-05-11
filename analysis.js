/**
 * Detects the BPM of an AudioBuffer and computes the beat grid.
 * Algorithm: amplitude envelope -> onset signal (first-order diff + threshold)
 * -> autocorrelation over lags for 60–180 BPM -> harmonic candidates from peaks
 * -> best BPM by onset-grid alignment + autocorrect -> sesquialtera (×1.5) check → beat timestamps.
 * this was really hard to understand and I had to google a lot to understand it. Some songs worked, others didn't
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

// How well does a BPM grid line up with onset energy (phase search)?
function gridAlignmentScore(bpm, decimated, reducedRate) {
  const beatSamples = (reducedRate * 60) / bpm;
  if (beatSamples < 2 || beatSamples > decimated.length / 6) return 0;

  const phases = 24;
  let best = 0;
  for (let p = 0; p < phases; p++) {
    const phaseOff = (p / phases) * beatSamples;
    let sum = 0;
    let count = 0;
    for (let t = phaseOff; t < decimated.length; t += beatSamples) {
      const i = Math.round(t);
      if (i >= 0 && i < decimated.length) {
        sum += decimated[i];
        count++;
      }
    }
    if (count === 0) continue;
    const avg = sum / count;
    if (avg > best) best = avg;
  }
  return best;
}

/** Combined score for a tempo hypothesis (grid alignment + normalized autocorr). */
function comboScoreForBpm(bpm, corrs, lagMin, lagMax, reducedRate, decimated, n, autocorrWeight) {
  const lag = Math.round((reducedRate * 60) / bpm);
  if (lag < lagMin || lag > lagMax) return -Infinity;
  const autocorrPart = corrs[lag - lagMin] / n;
  const gridPart = gridAlignmentScore(bpm, decimated, reducedRate);
  return gridPart + autocorrPart * autocorrWeight;
}

/**
 * Prefer BPM × 1.5 when autocorr/onsets weakly favor the slower sesquialtera aka 3:2 ratio
 * fixes 90→60, 126→84 while songs like Nice For What still pick ~93 over ~62 via scores.
 */
function preferSesquialteraBpm(baseBpm, corrs, lagMin, lagMax, reducedRate, decimated, n, autocorrWeight, globalPeakCorr) {
  const sesqui = Math.round(baseBpm * 1.5 * 10) / 10;
  if (sesqui < 60 || sesqui > 180 || Math.abs(sesqui - baseBpm) < 0.5) return baseBpm;

  const s0 = comboScoreForBpm(baseBpm, corrs, lagMin, lagMax, reducedRate, decimated, n, autocorrWeight);
  const s1 = comboScoreForBpm(sesqui, corrs, lagMin, lagMax, reducedRate, decimated, n, autocorrWeight);
  if (s0 === -Infinity || s1 === -Infinity) return baseBpm;

  const lag0 = Math.round((reducedRate * 60) / baseBpm);
  const lag1 = Math.round((reducedRate * 60) / sesqui);
  const ac0 = corrs[lag0 - lagMin];
  const ac1 = corrs[lag1 - lagMin];

  // Avoid stealing correct ~120 BPM into ~180; allow uplift when base is slow or sesqui is moderate.
  const clearWin =
    s1 >= s0 * 1.004 && (baseBpm <= 106 || sesqui <= 155);
  // Keep ≤ ~87 so ~93 BPM tracks (Nice For What) are not pulled toward ~140 via autocorr noise.
  const harmonicRescue =
    baseBpm <= 87 &&
    s1 >= s0 * 0.905 &&
    ac1 >= Math.max(ac0 * 0.52, globalPeakCorr * 0.22);

  if (clearWin || harmonicRescue) return sesqui;
  return baseBpm;
}

// Autocorrelation over lags corresponding to 60–180 BPM, then pick among harmonic
// candidates using onset-grid alignment (fixes hip-hop / swung tracks where raw
// autocorr favors a harmonic and old octave logic halved ~125 → ~62 vs true ~93).
function autocorrelationBPM(onsets, sampleRate) {
  const decimation = Math.floor(sampleRate / 200);
  const decimated = downsample(onsets, decimation);
  const reducedRate = sampleRate / decimation;

  const lagMin = Math.floor(reducedRate * 60 / 180); // lag for 180 BPM
  const lagMax = Math.floor(reducedRate * 60 / 60); // lag for 60 BPM
  const n = decimated.length;

  const numLags = lagMax - lagMin + 1;
  const corrs = new Float32Array(numLags);

  for (let li = 0; li < numLags; li++) {
    const lag = lagMin + li;
    let corr = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i++) {
      corr += decimated[i] * decimated[i + lag];
    }
    corrs[li] = corr;
  }

  let globalBestLi = 0;
  for (let li = 1; li < numLags; li++) {
    if (corrs[li] > corrs[globalBestLi]) globalBestLi = li;
  }

  const peaks = [];
  for (let li = 1; li < numLags - 1; li++) {
    if (corrs[li] > corrs[li - 1] && corrs[li] > corrs[li + 1]) {
      peaks.push({ lag: lagMin + li, corr: corrs[li] });
    }
  }
  peaks.sort((a, b) => b.corr - a.corr);

  const candidates = new Set();
  candidates.add(lagMin + globalBestLi);

  const maxPeaks = 12;
  const corrFloor = corrs[globalBestLi] * 0.35;
  for (let p = 0; p < Math.min(maxPeaks, peaks.length); p++) {
    if (peaks[p].corr < corrFloor) break;
    const lag = peaks[p].lag;
    candidates.add(lag);
    const half = Math.floor(lag / 2);
    const dbl = lag * 2;
    const third = Math.floor(lag / 3);
    const triple = lag * 3;
    if (half >= lagMin && half <= lagMax) candidates.add(half);
    if (dbl >= lagMin && dbl <= lagMax) candidates.add(dbl);
    if (third >= lagMin && third <= lagMax) candidates.add(third);
    if (triple >= lagMin && triple <= lagMax) candidates.add(triple);
  }

  const autocorrWeight = 0.34;
  const globalPeakCorr = corrs[globalBestLi];

  let bestBpm = (reducedRate * 60) / (lagMin + globalBestLi);
  let bestCombo = -Infinity;

  for (const lag of candidates) {
    if (lag < lagMin || lag > lagMax) continue;
    const bpm = (reducedRate * 60) / lag;
    if (bpm < 60 || bpm > 180) continue;
    const combo = comboScoreForBpm(bpm, corrs, lagMin, lagMax, reducedRate, decimated, n, autocorrWeight);
    if (combo > bestCombo) {
      bestCombo = combo;
      bestBpm = bpm;
    }
  }

  bestBpm = preferSesquialteraBpm(
    bestBpm,
    corrs,
    lagMin,
    lagMax,
    reducedRate,
    decimated,
    n,
    autocorrWeight,
    globalPeakCorr,
  );

  return Math.round(bestBpm * 10) / 10;
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
