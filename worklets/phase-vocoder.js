// Phase Vocoder AudioWorkletProcessor
// Self-contained — no imports (worklet scope restriction).
// Algorithm: STFT analysis → phase manipulation → ISTFT synthesis (overlap-add).
// Stretches time without changing pitch.
// Processes all input channels independently (stereo-safe).

const N  = 2048; // FFT size (power of 2)
const Ha = 512;  // analysis hop = N/4 → 75% overlap, satisfies COLA for Hann window

// ---------------------------------------------------------------------------
// Hann window
// ---------------------------------------------------------------------------
function makeHann(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

// ---------------------------------------------------------------------------
// Bit-reversal permutation (in-place on two parallel arrays)
// ---------------------------------------------------------------------------
function bitReverse(re, im, n) {
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

// Cooley-Tukey radix-2 in-place FFT.
function fft(re, im) {
  const n = re.length;
  bitReverse(re, im, n);
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const wRe = Math.cos(-2 * Math.PI / len);
    const wIm = Math.sin(-2 * Math.PI / len);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + halfLen] * curRe - im[i + j + halfLen] * curIm;
        const vIm = re[i + j + halfLen] * curIm + im[i + j + halfLen] * curRe;
        re[i + j]          = uRe + vRe;
        im[i + j]          = uIm + vIm;
        re[i + j + halfLen] = uRe - vRe;
        im[i + j + halfLen] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm        = curRe * wIm + curIm * wRe;
        curRe        = nextRe;
      }
    }
  }
}

// In-place IFFT: conjugate → FFT → conjugate → scale by 1/N.
function ifft(re, im) {
  const n = re.length;
  // Conjugate input.
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  // Conjugate output and scale.
  const inv = 1 / n;
  for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
}

// ---------------------------------------------------------------------------
// Phase wrapping to [-π, π]
// ---------------------------------------------------------------------------
function wrap(p) {
  while (p >  Math.PI) p -= 2 * Math.PI;
  while (p < -Math.PI) p += 2 * Math.PI;
  return p;
}

// ---------------------------------------------------------------------------
// Per-channel state factory
// ---------------------------------------------------------------------------
function makeChannelState() {
  const bins = N / 2 + 1;
  return {
    inputBuf:      new Float32Array(N * 4),
    outputBuf:     new Float32Array(N * 8),
    inputWritePos:  0,
    inputReadPos:   0,
    outputWritePos: 0,
    outputReadPos:  0,
    prevAnalPhase:  new Float32Array(bins),
    synthPhase:     new Float32Array(bins),
  };
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------
class PhaseVocoderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const sf = (options.processorOptions && options.processorOptions.stretchFactor) || 1;
    this.stretchFactor = sf;
    this.Hs = Math.max(1, Math.round(Ha * sf)); // synthesis hop

    this.hann = makeHann(N);

    // Per-channel state — allocated lazily once we know the channel count.
    this.channelStates = null;

    // Working FFT buffers — reused each frame (overwritten per channel, safe for sequential processing).
    this.re    = new Float32Array(N);
    this.im    = new Float32Array(N);
    this.frame = new Float32Array(N);
  }

  process(inputs, outputs) {
    // Determine actual channel count from the connected source.
    const numChannels = (inputs[0] && inputs[0].length) ? inputs[0].length : 1;

    // Allocate per-channel state lazily (or reallocate if channel count changed).
    if (!this.channelStates || this.channelStates.length !== numChannels) {
      this.channelStates = Array.from({ length: numChannels }, makeChannelState);
    }

    for (let ch = 0; ch < numChannels; ch++) {
      const input  = inputs[0][ch];
      const output = outputs[0][ch];
      if (!input || !output) continue;

      const s = this.channelStates[ch];
      const blockSize = output.length;

      // --- 1. Accumulate input ---
      const inBufLen = s.inputBuf.length;
      for (let i = 0; i < input.length; i++) {
        s.inputBuf[s.inputWritePos % inBufLen] = input[i];
        s.inputWritePos++;
      }

      // --- 2. Process frames whenever we have enough input ---
      while (s.inputWritePos - s.inputReadPos >= N) {
        // Extract windowed analysis frame.
        for (let i = 0; i < N; i++) {
          this.frame[i] = s.inputBuf[(s.inputReadPos + i) % inBufLen] * this.hann[i];
        }
        s.inputReadPos += Ha;

        // Copy into FFT working buffers.
        this.re.set(this.frame);
        this.im.fill(0);

        fft(this.re, this.im);

        // Phase vocoder: compute true instantaneous frequencies and advance synthesis phases.
        const bins = N / 2 + 1;
        for (let k = 0; k < bins; k++) {
          const mag       = Math.sqrt(this.re[k] * this.re[k] + this.im[k] * this.im[k]);
          const analPhase = Math.atan2(this.im[k], this.re[k]);

          const deltaPhase = analPhase - s.prevAnalPhase[k];
          const expected   = (2 * Math.PI * k * Ha) / N;
          const trueFreq   = (expected + wrap(deltaPhase - expected)) / Ha;

          s.prevAnalPhase[k] = analPhase;
          s.synthPhase[k]   += trueFreq * this.Hs;

          // Reconstruct bin with original magnitude and new synthesis phase.
          this.re[k] = mag * Math.cos(s.synthPhase[k]);
          this.im[k] = mag * Math.sin(s.synthPhase[k]);
        }

        // Mirror conjugate-symmetric upper bins for real IFFT.
        for (let k = bins; k < N; k++) {
          const mirror = N - k;
          this.re[k] =  this.re[mirror];
          this.im[k] = -this.im[mirror];
        }

        ifft(this.re, this.im);

        // Apply synthesis Hann window and overlap-add into output buffer.
        const outBufLen = s.outputBuf.length;
        for (let i = 0; i < N; i++) {
          const pos = (s.outputWritePos + i) % outBufLen;
          s.outputBuf[pos] += this.re[i] * this.hann[i];
        }
        s.outputWritePos += this.Hs;
      }

      // --- 3. Copy output block ---
      const outBufLen = s.outputBuf.length;
      const available = s.outputWritePos - s.outputReadPos;
      const toCopy    = Math.min(blockSize, available);

      for (let i = 0; i < toCopy; i++) {
        const pos   = (s.outputReadPos + i) % outBufLen;
        output[i]   = s.outputBuf[pos];
        s.outputBuf[pos] = 0; // clear after reading
      }
      // Zero-pad if output buffer hasn't filled yet (startup latency).
      for (let i = toCopy; i < blockSize; i++) output[i] = 0;

      s.outputReadPos += toCopy;
    }

    return true; // keep processor alive
  }
}

registerProcessor('phase-vocoder', PhaseVocoderProcessor);
