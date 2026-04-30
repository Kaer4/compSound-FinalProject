// Phase Vocoder AudioWorkletProcessor
// Self-contained — no imports (worklet scope restriction).
// Algorithm: STFT analysis → phase manipulation → ISTFT synthesis (overlap-add).
// Stretches time without changing pitch.

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
// Processor
// ---------------------------------------------------------------------------
class PhaseVocoderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const sf = (options.processorOptions && options.processorOptions.stretchFactor) || 1;
    this.stretchFactor = sf;
    this.Hs = Math.max(1, Math.round(Ha * sf)); // synthesis hop

    this.hann = makeHann(N);

    // Circular input accumulation buffer (4× frame size is plenty).
    this.inputBuf  = new Float32Array(N * 4);
    this.inputWritePos = 0;
    this.inputReadPos  = 0;

    // Linear output OLA accumulation buffer (8× to handle worst-case stretch).
    this.outputBuf      = new Float32Array(N * 8);
    this.outputWritePos = 0; // where the next OLA frame is written
    this.outputReadPos  = 0; // where the next 128-sample output block is read

    // Phase state.
    const bins = N / 2 + 1;
    this.prevAnalPhase = new Float32Array(bins);
    this.synthPhase    = new Float32Array(bins);

    // Working buffers (reused each frame to avoid GC pressure).
    this.re    = new Float32Array(N);
    this.im    = new Float32Array(N);
    this.frame = new Float32Array(N);
  }

  process(inputs, outputs) {
    const input  = inputs[0][0];   // mono input channel
    const output = outputs[0][0];  // mono output channel
    const blockSize = output ? output.length : 128;

    if (!input || !output) return true;

    // --- 1. Accumulate input ---
    const inBufLen = this.inputBuf.length;
    for (let i = 0; i < input.length; i++) {
      this.inputBuf[this.inputWritePos % inBufLen] = input[i];
      this.inputWritePos++;
    }

    // --- 2. Process frames whenever we have enough input ---
    while (this.inputWritePos - this.inputReadPos >= N) {
      // Extract windowed analysis frame.
      for (let i = 0; i < N; i++) {
        this.frame[i] = this.inputBuf[(this.inputReadPos + i) % inBufLen] * this.hann[i];
      }
      this.inputReadPos += Ha;

      // Copy into FFT working buffers.
      this.re.set(this.frame);
      this.im.fill(0);

      fft(this.re, this.im);

      // Phase vocoder: compute true instantaneous frequencies and advance synthesis phases.
      const bins = N / 2 + 1;
      for (let k = 0; k < bins; k++) {
        const mag      = Math.sqrt(this.re[k] * this.re[k] + this.im[k] * this.im[k]);
        const analPhase = Math.atan2(this.im[k], this.re[k]);

        const deltaPhase  = analPhase - this.prevAnalPhase[k];
        const expected    = (2 * Math.PI * k * Ha) / N;
        const trueFreq    = (expected + wrap(deltaPhase - expected)) / Ha;

        this.prevAnalPhase[k] = analPhase;
        this.synthPhase[k]   += trueFreq * this.Hs;

        // Reconstruct bin with original magnitude and new synthesis phase.
        this.re[k] = mag * Math.cos(this.synthPhase[k]);
        this.im[k] = mag * Math.sin(this.synthPhase[k]);
      }

      // Mirror conjugate-symmetric upper bins for real IFFT.
      for (let k = bins; k < N; k++) {
        const mirror = N - k;
        this.re[k] =  this.re[mirror];
        this.im[k] = -this.im[mirror];
      }

      ifft(this.re, this.im);

      // Apply synthesis Hann window and overlap-add into output buffer.
      const outBufLen = this.outputBuf.length;
      for (let i = 0; i < N; i++) {
        const pos = (this.outputWritePos + i) % outBufLen;
        this.outputBuf[pos] += this.re[i] * this.hann[i];
      }
      this.outputWritePos += this.Hs;
    }

    // --- 3. Copy output block ---
    const outBufLen = this.outputBuf.length;
    const available = this.outputWritePos - this.outputReadPos;
    const toCopy    = Math.min(blockSize, available);

    for (let i = 0; i < toCopy; i++) {
      const pos   = (this.outputReadPos + i) % outBufLen;
      output[i]   = this.outputBuf[pos];
      this.outputBuf[pos] = 0; // clear after reading
    }
    // Zero-pad if output buffer hasn't filled yet (startup latency).
    for (let i = toCopy; i < blockSize; i++) output[i] = 0;

    this.outputReadPos += toCopy;

    return true; // keep processor alive
  }
}

registerProcessor('phase-vocoder', PhaseVocoderProcessor);
