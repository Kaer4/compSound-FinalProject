/**
 * Builds and wires the effects rack UI for one track.
 * All sliders connect directly to AudioParam — no intermediate state.
 */

import { buildIR } from './effects.js';

/**
 * @param {string}       trackId  - 'a' or 'b'
 * @param {object}       chain    - from createEffectsChain()
 * @param {AudioContext} audioCtx
 * @returns {HTMLElement} - the populated .effects-panel div
 */
export function buildEffectsPanel(trackId, chain, audioCtx) {
  const panel = document.createElement('div');
  panel.className = 'effects-panel';

  panel.innerHTML = `
    <!-- EQ ───────────────────────────────────────── -->
    <div class="effect-section" id="fx-eq-${trackId}">
      <div class="effect-header">
        <span class="effect-label">EQ</span>
      </div>
      <div class="effect-controls">
        ${eqBandHTML('low',  trackId, 'LOW')}
        ${eqBandHTML('mid',  trackId, 'MID')}
        ${eqBandHTML('high', trackId, 'HIGH')}
        <div class="eq-footer">
          <button class="reset-btn" id="eq-reset-${trackId}">RESET ALL</button>
        </div>
      </div>
    </div>

    <!-- FILTER ────────────────────────────────────── -->
    <div class="effect-section" id="fx-filter-${trackId}">
      <div class="effect-header">
        <span class="effect-label">FILTER</span>
        <button class="fx-toggle" id="filter-toggle-${trackId}" data-active="false">OFF</button>
      </div>
      <div class="effect-controls">
        <div class="fx-row">
          <div class="type-group">
            <button class="type-btn active" id="lpf-btn-${trackId}">LPF</button>
            <button class="type-btn"        id="hpf-btn-${trackId}">HPF</button>
          </div>
        </div>
        <div class="fx-row">
          <label class="fx-label">CUTOFF</label>
          <input type="range" class="fx-slider" id="filter-cutoff-${trackId}"
                 min="0" max="1" step="0.001" value="1">
          <span class="fx-value" id="filter-cutoff-val-${trackId}">20 kHz</span>
        </div>
        <div class="fx-row">
          <label class="fx-label">RESONANCE</label>
          <input type="range" class="fx-slider" id="filter-q-${trackId}"
                 min="0.1" max="20" step="0.1" value="1">
          <span class="fx-value" id="filter-q-val-${trackId}">1.0</span>
        </div>
      </div>
    </div>

    <!-- DELAY ─────────────────────────────────────── -->
    <div class="effect-section" id="fx-delay-${trackId}">
      <div class="effect-header">
        <span class="effect-label">DELAY</span>
        <button class="fx-toggle" id="delay-toggle-${trackId}" data-active="false">OFF</button>
      </div>
      <div class="effect-controls">
        <div class="fx-row">
          <label class="fx-label">TIME</label>
          <input type="range" class="fx-slider" id="delay-time-${trackId}"
                 min="0" max="1" step="0.01" value="0.375">
          <span class="fx-value" id="delay-time-val-${trackId}">375 ms</span>
        </div>
        <div class="fx-row">
          <label class="fx-label">FEEDBACK</label>
          <input type="range" class="fx-slider" id="delay-feedback-${trackId}"
                 min="0" max="0.8" step="0.01" value="0.4">
          <span class="fx-value" id="delay-feedback-val-${trackId}">40%</span>
        </div>
        <div class="fx-row">
          <label class="fx-label">MIX</label>
          <input type="range" class="fx-slider" id="delay-mix-${trackId}"
                 min="0" max="1" step="0.01" value="0.5">
          <span class="fx-value" id="delay-mix-val-${trackId}">50%</span>
        </div>
      </div>
    </div>

    <!-- REVERB ────────────────────────────────────── -->
    <div class="effect-section" id="fx-reverb-${trackId}">
      <div class="effect-header">
        <span class="effect-label">REVERB</span>
        <button class="fx-toggle" id="reverb-toggle-${trackId}" data-active="false">OFF</button>
      </div>
      <div class="effect-controls">
        <div class="fx-row">
          <label class="fx-label">MIX</label>
          <input type="range" class="fx-slider" id="reverb-mix-${trackId}"
                 min="0" max="1" step="0.01" value="0.3">
          <span class="fx-value" id="reverb-mix-val-${trackId}">30%</span>
        </div>
        <div class="fx-row">
          <label class="fx-label">DECAY</label>
          <div class="type-group">
            <button class="type-btn active" data-duration="1.5" data-decay="1.5"
                    id="decay-short-${trackId}">SHORT</button>
            <button class="type-btn"        data-duration="2.5" data-decay="2.0"
                    id="decay-med-${trackId}">MED</button>
            <button class="type-btn"        data-duration="4.0" data-decay="1.2"
                    id="decay-long-${trackId}">LONG</button>
          </div>
        </div>
      </div>
    </div>
  `;

  wirePanel(panel, trackId, chain, audioCtx);
  return panel;
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function eqBandHTML(band, trackId, label) {
  return `
    <div class="eq-band">
      <label class="fx-label">${label}</label>
      <input type="range" class="fx-slider eq-slider" id="eq-${band}-${trackId}"
             min="-40" max="12" step="0.5" value="0">
      <span class="fx-value" id="eq-${band}-val-${trackId}">0 dB</span>
      <button class="kill-btn" id="kill-${band}-${trackId}">KILL</button>
    </div>
  `;
}

// ─── Wiring ────────────────────────────────────────────────────────────────────

function wirePanel(panel, id, chain, audioCtx) {
  const now = () => audioCtx.currentTime;
  const q   = sel => panel.querySelector(sel);

  // ── EQ ──────────────────────────────────────────────────────────────────────
  const eqBands = [
    { band: 'low',  node: chain.eq.low  },
    { band: 'mid',  node: chain.eq.mid  },
    { band: 'high', node: chain.eq.high },
  ];

  for (const { band, node } of eqBands) {
    const slider  = q(`#eq-${band}-${id}`);
    const display = q(`#eq-${band}-val-${id}`);
    const killBtn = q(`#kill-${band}-${id}`);

    slider.addEventListener('input', () => {
      const dB = Number(slider.value);
      node.gain.setValueAtTime(dB, now());
      display.textContent = formatDB(dB);
      // Deactivate kill if slider moved away from -40
      killBtn.classList.toggle('active', dB <= -40);
    });

    killBtn.addEventListener('click', () => {
      const killing = !killBtn.classList.contains('active');
      const dB = killing ? -40 : 0;
      node.gain.setValueAtTime(dB, now());
      slider.value = dB;
      display.textContent = formatDB(dB);
      killBtn.classList.toggle('active', killing);
    });
  }

  // Single RESET button — zeros all three bands.
  q(`#eq-reset-${id}`).addEventListener('click', () => {
    for (const { band, node } of eqBands) {
      node.gain.setValueAtTime(0, now());
      q(`#eq-${band}-${id}`).value = 0;
      q(`#eq-${band}-val-${id}`).textContent = formatDB(0);
      q(`#kill-${band}-${id}`).classList.remove('active');
    }
  });

  // ── Filter ───────────────────────────────────────────────────────────────────
  const filterToggle  = q(`#filter-toggle-${id}`);
  const lpfBtn        = q(`#lpf-btn-${id}`);
  const hpfBtn        = q(`#hpf-btn-${id}`);
  const cutoffSlider  = q(`#filter-cutoff-${id}`);
  const cutoffDisplay = q(`#filter-cutoff-val-${id}`);
  const qSlider       = q(`#filter-q-${id}`);
  const qDisplay      = q(`#filter-q-val-${id}`);

  // Log-scale mapping: slider 0→1 maps to 20→20000 Hz via 20 × 1000^t
  const sliderToHz = t  => 20 * Math.pow(1000, t);
  const neutralHz  = () => chain.filter.node.type === 'lowpass' ? 20000 : 20;

  function applyFilterFreq() {
    const hz = chain.filter.enabled ? sliderToHz(Number(cutoffSlider.value)) : neutralHz();
    chain.filter.node.frequency.setValueAtTime(hz, now());
  }

  filterToggle.addEventListener('click', () => {
    chain.filter.enabled = !chain.filter.enabled;
    filterToggle.textContent     = chain.filter.enabled ? 'ON' : 'OFF';
    filterToggle.dataset.active  = String(chain.filter.enabled);
    applyFilterFreq();
  });

  lpfBtn.addEventListener('click', () => {
    chain.filter.node.type = 'lowpass';
    lpfBtn.classList.add('active');
    hpfBtn.classList.remove('active');
    applyFilterFreq();
  });

  hpfBtn.addEventListener('click', () => {
    chain.filter.node.type = 'highpass';
    hpfBtn.classList.add('active');
    lpfBtn.classList.remove('active');
    applyFilterFreq();
  });

  cutoffSlider.addEventListener('input', () => {
    const hz = sliderToHz(Number(cutoffSlider.value));
    cutoffDisplay.textContent = formatHz(hz);
    if (chain.filter.enabled) chain.filter.node.frequency.setValueAtTime(hz, now());
  });

  qSlider.addEventListener('input', () => {
    const q = Number(qSlider.value);
    chain.filter.node.Q.setValueAtTime(q, now());
    qDisplay.textContent = q.toFixed(1);
  });

  // ── Delay ────────────────────────────────────────────────────────────────────
  const delayToggle   = q(`#delay-toggle-${id}`);
  const timeSlider    = q(`#delay-time-${id}`);
  const timeDisplay   = q(`#delay-time-val-${id}`);
  const fbSlider      = q(`#delay-feedback-${id}`);
  const fbDisplay     = q(`#delay-feedback-val-${id}`);
  const mixSlider     = q(`#delay-mix-${id}`);
  const mixDisplay    = q(`#delay-mix-val-${id}`);

  function applyDelayMix(enabled) {
    const mix = enabled ? Number(mixSlider.value) : 0;
    chain.delay.wet.gain.setValueAtTime(mix,     now());
    chain.delay.dry.gain.setValueAtTime(1 - mix, now());
  }

  delayToggle.addEventListener('click', () => {
    chain.delay.enabled = !chain.delay.enabled;
    delayToggle.textContent    = chain.delay.enabled ? 'ON' : 'OFF';
    delayToggle.dataset.active = String(chain.delay.enabled);
    applyDelayMix(chain.delay.enabled);
  });

  timeSlider.addEventListener('input', () => {
    const t = Number(timeSlider.value);
    chain.delay.node.delayTime.setValueAtTime(t, now());
    timeDisplay.textContent = `${Math.round(t * 1000)} ms`;
  });

  fbSlider.addEventListener('input', () => {
    const fb = Number(fbSlider.value);
    chain.delay.feedback.gain.setValueAtTime(fb, now());
    fbDisplay.textContent = `${Math.round(fb * 100)}%`;
  });

  mixSlider.addEventListener('input', () => {
    mixDisplay.textContent = `${Math.round(Number(mixSlider.value) * 100)}%`;
    if (chain.delay.enabled) applyDelayMix(true);
  });

  // ── Reverb ───────────────────────────────────────────────────────────────────
  const reverbToggle  = q(`#reverb-toggle-${id}`);
  const revMixSlider  = q(`#reverb-mix-${id}`);
  const revMixDisplay = q(`#reverb-mix-val-${id}`);
  const decayBtns     = panel.querySelectorAll(`[id^="decay-"][id$="-${id}"]`);

  function applyReverbMix(enabled) {
    const mix = enabled ? Number(revMixSlider.value) : 0;
    chain.reverb.wet.gain.setValueAtTime(mix,     now());
    chain.reverb.dry.gain.setValueAtTime(1 - mix, now());
  }

  reverbToggle.addEventListener('click', () => {
    chain.reverb.enabled = !chain.reverb.enabled;
    reverbToggle.textContent    = chain.reverb.enabled ? 'ON' : 'OFF';
    reverbToggle.dataset.active = String(chain.reverb.enabled);
    applyReverbMix(chain.reverb.enabled);
  });

  revMixSlider.addEventListener('input', () => {
    revMixDisplay.textContent = `${Math.round(Number(revMixSlider.value) * 100)}%`;
    if (chain.reverb.enabled) applyReverbMix(true);
  });

  decayBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      decayBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const duration = Number(btn.dataset.duration);
      const decay    = Number(btn.dataset.decay);
      chain.reverb.convolver.buffer = buildIR(audioCtx, duration, decay);
    });
  });
}

// ─── Formatting helpers ────────────────────────────────────────────────────────

function formatDB(dB) {
  return `${dB > 0 ? '+' : ''}${dB.toFixed(1)} dB`;
}

function formatHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}
