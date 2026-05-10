// ---------------------------------------------------------------------------
// BPM alignment helpers
// ---------------------------------------------------------------------------

/**
 * Computes the playback rate to apply to the incoming track so its tempo
 * matches the master track's tempo. Used when BPM difference is within `needsTimeStretch` (playback-rate path).
 */
export function computePlaybackRate(masterBpm, incomingBpm) {
  const ratio = masterBpm / incomingBpm;
  return Math.max(0.5, Math.min(2.0, ratio));
}

/**
 * Returns true when the BPM difference warrants phase vocoder time-stretching
 * (> ~3.5% deviation from master tempo).
 */
export function needsTimeStretch(masterBpm, incomingBpm) {
  // Slightly wider than 2% so more mixes use playbackRate (less phase-vocoder time on ear).
  return Math.abs(1 - masterBpm / incomingBpm) > 0.035;
}

/**
 * Time-stretches an AudioBuffer to match the master BPM.
 * Tries the AudioWorklet path first; falls back to pure-JS if the browser
 * does not support AudioWorklet in OfflineAudioContext.
 *
 * stretchFactor = incomingBpm / masterBpm
 *   > 1 → incoming is faster → output is longer (slowed down to match master)
 *   < 1 → incoming is slower → output is shorter (sped up to match master)
 *
 * @param {AudioBuffer} audioBuffer
 * @param {number} masterBpm
 * @param {number} incomingBpm
 * @returns {Promise<AudioBuffer>}
 */
/**
 * Extracts a sub-buffer (slice) from audioBuffer starting at startTime for duration seconds.
 * Use this to pull out just the crossfade segment before time-stretching.
 *
 * @param {AudioBuffer} audioBuffer
 * @param {number} startTime  - start position in seconds
 * @param {number} duration   - length to extract in seconds
 * @param {AudioContext} audioCtx
 * @returns {AudioBuffer}
 */
export function extractSegment(audioBuffer, startTime, duration, audioCtx) {
  const sr          = audioBuffer.sampleRate;
  const startSample = Math.floor(startTime * sr);
  const numSamples  = Math.ceil(duration * sr);
  const clamped     = Math.min(numSamples, audioBuffer.length - startSample);
  const out = audioCtx.createBuffer(audioBuffer.numberOfChannels, clamped, sr);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    out.copyToChannel(
      audioBuffer.getChannelData(ch).subarray(startSample, startSample + clamped),
      ch,
    );
  }
  return out;
}

/**
 * Trims a buffer to at most `durationSeconds` of audio (discards tail past the fade window).
 * No-op if already shorter or equal.
 *
 * @param {AudioContext} audioCtx
 * @param {AudioBuffer} audioBuffer
 * @param {number} durationSeconds
 * @returns {AudioBuffer}
 */
export function trimBufferToWallClock(audioCtx, audioBuffer, durationSeconds) {
  const sr = audioBuffer.sampleRate;
  const targetFrames = Math.round(durationSeconds * sr);
  if (audioBuffer.length <= targetFrames) return audioBuffer;

  const out = audioCtx.createBuffer(audioBuffer.numberOfChannels, targetFrames, sr);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    out.copyToChannel(audioBuffer.getChannelData(ch).subarray(0, targetFrames), ch);
  }
  return out;
}

export async function timeStretchBuffer(audioBuffer, masterBpm, incomingBpm, audioCtx) {
  try {
    return await _timeStretchViaWorklet(audioBuffer, masterBpm, incomingBpm);
  } catch {
    // OfflineAudioContext does not support AudioWorklet in this environment —
    // fall back to the equivalent pure-JS implementation.
    return _timeStretchPureJS(audioBuffer, masterBpm, incomingBpm, audioCtx);
  }
}

// ---------------------------------------------------------------------------
// Worklet path (Chrome / Firefox with OfflineAudioContext AudioWorklet support)
// ---------------------------------------------------------------------------
async function _timeStretchViaWorklet(audioBuffer, masterBpm, incomingBpm) {
  const stretchFactor = incomingBpm / masterBpm;
  const outputLength  = Math.ceil(audioBuffer.length * stretchFactor);

  const offlineCtx = new OfflineAudioContext(
    audioBuffer.numberOfChannels,
    outputLength,
    audioBuffer.sampleRate,
  );

  // Throws if audioWorklet is undefined — caught by caller.
  await offlineCtx.audioWorklet.addModule('worklets/phase-vocoder.js');

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;

  const vocoder = new AudioWorkletNode(offlineCtx, 'phase-vocoder', {
    processorOptions: { stretchFactor },
    channelCount: audioBuffer.numberOfChannels,
    channelCountMode: 'explicit',
  });

  source.connect(vocoder);
  vocoder.connect(offlineCtx.destination);
  source.start();

  return offlineCtx.startRendering();
}

// ---------------------------------------------------------------------------
// Pure-JS fallback — same algorithm as the AudioWorklet, runs on main thread
// ---------------------------------------------------------------------------
export const PV_N  = 4096; // FFT size (keep in sync with worklets/phase-vocoder.js N)
export const PV_Ha = 1024; // analysis hop N/4 (75% overlap — matches worklet Ha)

/**
 * Returns the duration (seconds) of trailing silence at the end of an AudioBuffer.
 * Scans all channels and returns the worst-case (longest) tail across channels.
 * Works for both the worklet path (which can leave ~N samples of startup-latency
 * silence at the end) and the pure-JS fallback (shorter tail, depends on frame count).
 *
 * @param {AudioBuffer} audioBuffer
 * @param {number} [threshold=1e-4] - amplitude below which a sample is considered silent
 * @returns {number} tail silence in seconds
 */
export function measureTailSilence(audioBuffer, threshold = 1e-4) {
  let lastNonSilent = 0;
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    let i = data.length - 1;
    while (i > lastNonSilent && Math.abs(data[i]) < threshold) i--;
    if (i > lastNonSilent) lastNonSilent = i;
  }
  return (audioBuffer.length - 1 - lastNonSilent) / audioBuffer.sampleRate;
}

async function _timeStretchPureJS(audioBuffer, masterBpm, incomingBpm, audioCtx) {
  const stretchFactor = incomingBpm / masterBpm;
  const Hs = Math.max(1, Math.round(PV_Ha * stretchFactor));
  const hann = _makeHann(PV_N);
  const bins = PV_N / 2 + 1;

  const numChannels = audioBuffer.numberOfChannels;
  const inputLen    = audioBuffer.length;
  const outputLen   = Math.ceil(inputLen * stretchFactor);

  const outBuffer = audioCtx.createBuffer(numChannels, outputLen, audioBuffer.sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const input   = audioBuffer.getChannelData(ch);
    const output  = new Float32Array(outputLen);
    const normBuf = new Float32Array(outputLen);

    const prevPhase  = new Float32Array(bins);
    const synthPhase = new Float32Array(bins);
    const re = new Float32Array(PV_N);
    const im = new Float32Array(PV_N);

    const numFrames = Math.floor((inputLen - PV_N) / PV_Ha) + 1;

    // Yield to the browser event loop approximately every 16ms so the UI
    // stays responsive while the vocoder crunches through the buffer.
    let lastYield = Date.now();

    for (let f = 0; f < numFrames; f++) {
      if (Date.now() - lastYield > 16) {
        await new Promise(r => setTimeout(r, 0));
        lastYield = Date.now();
      }

      const inPos  = f * PV_Ha;
      const outPos = f * Hs;

      // Windowed analysis frame.
      re.fill(0); im.fill(0);
      for (let i = 0; i < PV_N; i++) {
        re[i] = (inPos + i < inputLen ? input[inPos + i] : 0) * hann[i];
      }

      _fft(re, im);

      // Phase vocoder: compute instantaneous frequencies, advance synthesis phases.
      for (let k = 0; k < bins; k++) {
        const mag   = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const phase = Math.atan2(im[k], re[k]);

        const expected = (2 * Math.PI * k * PV_Ha) / PV_N;
        const trueFreq = (expected + _wrap(phase - prevPhase[k] - expected)) / PV_Ha;

        prevPhase[k]   = phase;
        synthPhase[k] += trueFreq * Hs;

        re[k] = mag * Math.cos(synthPhase[k]);
        im[k] = mag * Math.sin(synthPhase[k]);
      }

      // Mirror conjugate-symmetric upper bins for real IFFT.
      for (let k = bins; k < PV_N; k++) {
        re[k] =  re[PV_N - k];
        im[k] = -im[PV_N - k];
      }

      _ifft(re, im);

      // Overlap-add with synthesis Hann window; accumulate window² for normalisation.
      for (let i = 0; i < PV_N; i++) {
        if (outPos + i < outputLen) {
          output[outPos + i]  += re[i] * hann[i];
          normBuf[outPos + i] += hann[i] * hann[i];
        }
      }
    }

    // Normalise each output sample by its accumulated window weight.
    for (let i = 0; i < outputLen; i++) {
      if (normBuf[i] > 1e-8) output[i] /= normBuf[i];
    }

    outBuffer.copyToChannel(output, ch);
  }

  return outBuffer;
}

// ---------------------------------------------------------------------------
// DSP primitives
// ---------------------------------------------------------------------------

function _makeHann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

function _wrap(p) {
  while (p >  Math.PI) p -= 2 * Math.PI;
  while (p < -Math.PI) p += 2 * Math.PI;
  return p;
}

function _bitReverse(re, im, n) {
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
}

function _fft(re, im) {
  const n = re.length;
  _bitReverse(re, im, n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const wRe  = Math.cos(-2 * Math.PI / len);
    const wIm  = Math.sin(-2 * Math.PI / len);
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k],          uIm = im[i + k];
        const vRe = re[i + k + half] * cRe - im[i + k + half] * cIm;
        const vIm = re[i + k + half] * cIm + im[i + k + half] * cRe;
        re[i + k]         = uRe + vRe;  im[i + k]         = uIm + vIm;
        re[i + k + half]  = uRe - vRe;  im[i + k + half]  = uIm - vIm;
        const nCRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nCRe;
      }
    }
  }
}

function _ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  _fft(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
}
