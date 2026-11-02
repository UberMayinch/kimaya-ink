/*
 * soundtrack.js — the sound layer for the scroll journey.
 * Classic script, no deps. Exposes window.KimayaSound.
 *
 * Bed, in order of preference:
 *   1. a buffer you load(url) yourself (a properly licensed file)
 *   2. the 30 s Apple Music preview of "Pink + White" (Frank Ocean), streamed
 *      from Apple's CDN (CORS: access-control-allow-origin: *), looped with
 *      equal-power crossfades. Never downloaded/hosted by us.
 *   3. a procedural lo-fi pad (fallback: offline, lookup failed, preview error)
 * Everything runs through one chain:
 *   source -> tape saturation -> warmth shelf -> lowpass -> air shelf -> wow/flutter
 *   -> dry + plate send -> level (journey + dropouts) -> duck -> glue comp -> limiter -> out
 *
 * Nothing plays until start() is called from a user gesture.
 */
(function () {
  "use strict";

  const PREF_KEY = "kimaya:sound";
  const META_KEY = "kimaya:soundtrack-song";

  const SONG = {
    id: 1146195714, // verified 2026-11: "Pink + White" — Frank Ocean, Blonde
    title: "Pink + White",
    artist: "Frank Ocean",
    term: "Pink + White Frank Ocean",
    matchTitle: /^pink\s*\+\s*white$/i,
    matchArtist: /frank ocean/i,
    trackViewUrl: "https://music.apple.com/us/album/pink-white/1146195596?i=1146195714&uo=4",
  };

  // beat points (journey progress 0..1). retune with KimayaSound.configure({ beats: {...} })
  const beats = {
    face: 0.3, // camera lowered, pushed in to her face
    eye: 0.45, // into her eyes
    pupil: 0.76, // black: inside the pupil
    front: 0.78, // the digicam's front
    lens: 0.9, // black: through the small top lens
    back: 0.92, // the camera's back LCD (gallery)
  };

  const opts = {
    songTrim: 0.3, // ~-10.5 dB: previews are mastered hot. set so the preview sits ~level with the pad (measured live)
    synthTrim: 1,
    xfade: 3, // seconds, song loop crossfade
    duckTo: 0.1, // bed level while another song preview plays
    songSlow: 0.025, // playbackRate drop at the eye (pitch drops too: tape-slow)
    synthSlowCents: 30, // pad detune at the eye
    fallbackAfter: 9000, // ms without the preview playing -> procedural bed
    shutterWhirr: false, // the little motor after the clicks. off: it reads as a glitch, not a camera
  };

  // ---------- small helpers ----------

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (x, a, b) => {
    const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const reducedMotion = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // re-aim a param that may be mid-curve: hold where it is, then glide (no jump, no overlap error)
  function retarget(param, value, ctx, tc) {
    const t = ctx.currentTime;
    const v = param.value;
    param.cancelScheduledValues(0);
    param.setValueAtTime(v, t);
    param.setTargetAtTime(value, t, tc);
  }

  // ramp a param with no zipper noise. first=true jumps (used before anything is audible).
  function setT(param, value, when, tc, first) {
    if (first) {
      param.cancelScheduledValues(0);
      param.setValueAtTime(value, when);
    } else {
      param.setTargetAtTime(value, when, tc);
    }
  }

  // ---------- journey -> mix ----------
  // each anchor: lp (Hz), wet (plate send), lvl, slow (0..1 tape slow), warm/air (shelf dB), hiss (0..1)
  function anchors() {
    const b = beats;
    const far = { lp: 650, wet: 0.55, lvl: 0.6, slow: 0, warm: 3, air: -9, hiss: 1 };
    const open = { lp: 4200, wet: 0.32, lvl: 0.85, slow: 0, warm: 2, air: -2, hiss: 0.7 };
    const close = { lp: 3000, wet: 0.1, lvl: 0.84, slow: 0.7, warm: 5, air: -4, hiss: 0.5 };
    const closest = { lp: 2400, wet: 0.07, lvl: 0.8, slow: 1, warm: 6, air: -5, hiss: 0.45 };
    const airy = { lp: 14000, wet: 0.45, lvl: 0.9, slow: 0, warm: 0, air: 5, hiss: 0.35 };
    const clean = { lp: 18000, wet: 0.14, lvl: 1, slow: 0, warm: 1.5, air: 1.5, hiss: 0.2 };
    return [
      [0, far],
      [b.face * 0.35, far], // camera still lowering: stay distant
      [b.face, open],
      [b.eye, close],
      [b.pupil - 0.03, closest],
      [b.front, airy],
      [b.lens - 0.025, airy],
      [b.back, clean],
      [1, clean],
    ];
  }

  function mixAt(p) {
    const a = anchors();
    p = clamp(p, 0, 1);
    let i = 0;
    while (i < a.length - 2 && p > a[i + 1][0]) i++;
    const [p0, m0] = a[i];
    const [p1, m1] = a[i + 1];
    const t = smooth(p, p0, p1);
    const out = {};
    for (const k in m0) out[k] = lerp(m0[k], m1[k], t);
    out.lp = Math.exp(lerp(Math.log(m0.lp), Math.log(m1.lp), t)); // filters move in octaves
    return out;
  }

  // screen-black estimate from the beats, used when the journey doesn't pass its own
  function blackAt(p) {
    const b = beats;
    const win = (a0, a1, b0, b1) => smooth(p, a0, a1) * (1 - smooth(p, b0, b1));
    return Math.max(
      win(b.pupil - 0.03, b.pupil, b.front - 0.004, b.front + 0.012),
      win(b.lens - 0.025, b.lens, b.back - 0.004, b.back + 0.012)
    );
  }

  // ---------- buffers ----------

  function noiseBuffer(ctx, seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      // Paul Kellet's pink filter: tape hiss is pinkish, not white
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
      // fade the seam so the loop doesn't tick
      const f = Math.floor(ctx.sampleRate * 0.02);
      for (let i = 0; i < f; i++) {
        const g = i / f;
        d[i] *= g;
        d[n - 1 - i] *= g;
      }
    }
    return buf;
  }

  function whiteBuffer(ctx, seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // a soft plate: decaying stereo noise that darkens as it decays
  function plateIR(ctx, seconds) {
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const pre = Math.floor(sr * 0.022);
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / sr;
        const env = Math.exp(-t * 2.3) * (1 - (i - pre) / (n - pre));
        const k = 0.55 - 0.45 * Math.min(1, t / seconds); // cutoff falls over the tail
        lp += k * (Math.random() * 2 - 1 - lp);
        d[i] = lp * env;
      }
      // soft onset
      const f = Math.floor(sr * 0.01);
      for (let i = 0; i < f; i++) d[pre + i] *= i / f;
    }
    return buf;
  }

  function satCurve(k) {
    const n = 2048;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / k; // unity at low level, rounds off peaks
    }
    return c;
  }

  // ---------- procedural pad ----------
  // a slow four-chord loop in D: Dmaj9 – Bm9 – Gmaj9 – Asus. 8 s per chord.
  const CHORD_LEN = 8;
  const PROG = [
    { bass: 38, notes: [50, 57, 61, 64, 66], mel: [[0.5, 78], [1.5, 76], [2.0, 73], [3.5, 69], [5.0, 76]] },
    { bass: 35, notes: [50, 54, 57, 61, 66], mel: [[0.5, 74], [1.5, 73], [2.5, 69], [4.0, 66], [6.0, 69]] },
    { bass: 43, notes: [50, 54, 57, 59, 62], mel: [[0.5, 71], [1.0, 74], [2.0, 78], [3.5, 76], [5.5, 74]] },
    { bass: 45, notes: [50, 52, 57, 59, 64], mel: [[0.5, 76], [2.0, 73], [3.0, 71], [4.5, 69], [6.5, 64]] },
  ];

  function Synth(eng) {
    const ctx = eng.ctx;
    this.eng = eng;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    // bells go through a muted lowpass and a dark dub echo
    this.bell = ctx.createGain();
    this.bell.gain.value = 1;
    const bellLP = ctx.createBiquadFilter();
    bellLP.type = "lowpass";
    bellLP.frequency.value = 3000;
    bellLP.Q.value = 0.3;
    const echo = ctx.createDelay(2);
    echo.delayTime.value = 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.3;
    const echoLP = ctx.createBiquadFilter();
    echoLP.type = "lowpass";
    echoLP.frequency.value = 1700;
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.45;
    this.bell.connect(bellLP);
    bellLP.connect(this.out);
    bellLP.connect(echo);
    echo.connect(echoLP);
    echoLP.connect(fb);
    fb.connect(echo);
    echoLP.connect(echoOut);
    echoOut.connect(this.out);
    this.next = 0; // index of the next chord to schedule
    this.t0 = null;
  }

  Synth.prototype.chord = function (i, t) {
    const ctx = this.eng.ctx;
    const c = PROG[i % PROG.length];
    const cycle = Math.floor(i / PROG.length);
    const end = t + CHORD_LEN;
    const att = 2.4, rel = 3.2;
    const stopAt = end + rel * 2.2;

    // pad: two detuned saws + a triangle per note, one breathing lowpass per chord
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(800, t);
    lp.frequency.linearRampToValueAtTime(3200, t + att);
    lp.frequency.linearRampToValueAtTime(2000, end);
    lp.frequency.linearRampToValueAtTime(900, end + rel);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + att);
    env.gain.setValueAtTime(1, end);
    env.gain.setTargetAtTime(0, end, rel / 3);
    lp.connect(env);
    env.connect(this.out);

    // the two detuned saws of each note sit on opposite sides: width without phasey mono
    const top = c.notes.length - 1;
    c.notes.forEach((m, k) => {
      const spread = 0.35 + 0.35 * (k / top);
      const voices = [[-8, "sawtooth", 0.04, -spread], [8, "sawtooth", 0.04, spread], [0, "triangle", 0.03, 0]];
      if (k >= top - 1) voices.push([1200 + 4, "sine", 0.018, k === top ? 0.5 : -0.5]); // octave shimmer
      voices.forEach(([cents, type, g, pv]) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = mtof(m);
        o.detune.value = cents + (Math.random() * 4 - 2);
        this.eng.detune.connect(o.detune);
        o.onended = () => this.eng.detune.disconnect(o.detune); // let stopped voices be freed
        const og = ctx.createGain();
        og.gain.value = g;
        const pan = ctx.createStereoPanner();
        pan.pan.value = pv;
        o.connect(og);
        og.connect(pan);
        pan.connect(lp);
        o.start(t);
        o.stop(stopAt);
      });
    });

    // bass: a round sine with a little second harmonic
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, t);
    bg.gain.linearRampToValueAtTime(0.06, t + 1.2);
    bg.gain.setValueAtTime(0.06, end - 0.4);
    bg.gain.setTargetAtTime(0, end - 0.4, 0.5);
    bg.connect(this.out);
    [[1, 1], [2, 0.3]].forEach(([h, g]) => {
      const o = ctx.createOscillator();
      o.frequency.value = mtof(c.bass) * h;
      this.eng.detune.connect(o.detune);
      o.onended = () => this.eng.detune.disconnect(o.detune);
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og);
      og.connect(bg);
      o.start(t);
      o.stop(end + 3);
    });

    // bell motif: drop a note now and then on later cycles so the loop breathes
    c.mel.forEach(([dt, m], k) => {
      if (cycle % 2 === 1 && k === 3) return;
      if (cycle % 3 === 2 && k === 1) return;
      const v = k === 0 ? 0.1 : 0.075;
      bell(this.eng, this.bell, t + dt, mtof(m), v, 0.42, true);
    });
  };

  // soft FM bell (also used for the power chime)
  function bell(eng, dest, t, f, v, decay, detuned) {
    const ctx = eng.ctx;
    const car = ctx.createOscillator();
    car.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * 2;
    const idx = ctx.createGain();
    idx.gain.setValueAtTime(f * 1.1, t);
    idx.gain.setTargetAtTime(0, t, 0.18);
    mod.connect(idx);
    idx.connect(car.frequency);
    if (detuned) {
      eng.detune.connect(car.detune);
      eng.detune.connect(mod.detune);
      car.onended = () => {
        eng.detune.disconnect(car.detune);
        eng.detune.disconnect(mod.detune);
      };
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.006);
    g.gain.setTargetAtTime(0, t + 0.006, decay);
    car.connect(g);
    g.connect(dest);
    const stop = t + decay * 8;
    car.start(t);
    mod.start(t);
    car.stop(stop);
    mod.stop(stop);
  }

  // schedule every chord that starts before `until`
  Synth.prototype.schedule = function (until) {
    if (this.t0 === null) return;
    while (this.t0 + this.next * CHORD_LEN < until) {
      this.chord(this.next, this.t0 + this.next * CHORD_LEN);
      this.next++;
    }
  };
  Synth.prototype.begin = function (t) {
    this.t0 = t;
    this.next = 0;
  };
  Synth.prototype.halt = function () {
    this.t0 = null;
  };

  // ---------- the engine (works on AudioContext or OfflineAudioContext) ----------

  function Engine(ctx) {
    this.ctx = ctx;
    const g = (v) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    const bq = (type, f, q) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      if (q !== undefined) n.Q.value = q;
      return n;
    };

    this.noise = noiseBuffer(ctx, 6);
    this.white = whiteBuffer(ctx, 1);
    this.tick = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.006), ctx.sampleRate);
    {
      const d = this.tick.getChannelData(0);
      let x = 12345;
      for (let i = 0; i < d.length; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff; // seeded: a fixed tick
        d[i] = (x / 0x3fffffff - 1) * (1 - i / d.length);
      }
    }

    // sources
    this.input = g(1);
    this.srcSynth = g(0);
    this.srcSong = g(0);
    this.srcBuf = g(0);
    this.srcSynth.connect(this.input);
    this.srcSong.connect(this.input);
    this.srcBuf.connect(this.input);

    // global pitch offset for the synth (tape slow)
    this.detune = ctx.createConstantSource();
    this.detune.offset.value = 0;
    this.detune.start(0);

    // tone
    this.sat = ctx.createWaveShaper();
    this.sat.curve = satCurve(1.25);
    this.sat.oversample = "2x";
    this.warm = bq("lowshelf", 220);
    this.lp = bq("lowpass", 18000, 0.5);
    this.air = bq("highshelf", 5500);
    this.input.connect(this.sat);
    this.sat.connect(this.warm);
    this.warm.connect(this.lp);
    this.lp.connect(this.air);

    // wow & flutter: a modulated short delay bends the pitch of anything passing through
    this.wow = ctx.createDelay(0.1);
    this.wow.delayTime.value = 0.012;
    this.air.connect(this.wow);
    this.wowDepth = g(1);
    [[0.33, 0.0011], [0.71, 0.0003], [6.3, 0.00003]].forEach(([f, d]) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const og = g(d);
      o.connect(og);
      og.connect(this.wowDepth);
      o.start(0);
    });
    this.wowDepth.connect(this.wow.delayTime);

    // space
    this.dry = g(1);
    this.send = g(0.2);
    this.plate = ctx.createConvolver();
    this.plate.buffer = plateIR(ctx, 3.4);
    this.wet = g(0.9);
    this.wow.connect(this.dry);
    this.wow.connect(this.send);
    this.send.connect(this.plate);
    this.plate.connect(this.wet);

    // journey level (incl. dropouts) and ducking
    this.level = g(1);
    this.dry.connect(this.level);
    this.wet.connect(this.level);
    this.duckG = g(1);
    this.level.connect(this.duckG);

    // tape hiss: always there, quietly
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noise;
    hiss.loop = true;
    const hHP = bq("highpass", 2200, 0.5);
    const hLP = bq("lowpass", 9000, 0.5);
    this.hiss = g(0.004);
    hiss.connect(hHP);
    hHP.connect(hLP);
    hLP.connect(this.hiss);
    this.hiss.connect(this.duckG);
    hiss.start(0);

    // dropout wash: filtered noise that rises as the screen goes black, cut at full black
    const wash = ctx.createBufferSource();
    wash.buffer = this.noise;
    wash.loop = true;
    wash.loopStart = 1.3;
    this.washBP = bq("bandpass", 400, 0.9);
    this.wash = g(0);
    wash.connect(this.washBP);
    this.washBP.connect(this.wash);
    this.wash.connect(this.duckG);
    wash.start(0, 1.3);

    // master: gentle glue, then a fast limiter
    this.bus = g(1);
    this.duckG.connect(this.bus);
    this.sfx = g(1);
    this.boomBus = g(1);
    this.boomBus.connect(this.bus);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 2;
    this.comp.attack.value = 0.03;
    this.comp.release.value = 0.4;
    this.lim = ctx.createDynamicsCompressor();
    this.lim.threshold.value = -3;
    this.lim.knee.value = 0;
    this.lim.ratio.value = 20;
    this.lim.attack.value = 0.001;
    this.lim.release.value = 0.1;
    this.trim = g(1); // after the compressors' automatic makeup gain
    this.out = g(0);
    this.bus.connect(this.comp);
    this.comp.connect(this.lim);
    this.sfx.connect(this.lim); // SFX skip the glue comp: it would flatten their transients
    this.lim.connect(this.trim);
    this.trim.connect(this.out);
    this.out.connect(ctx.destination);

    this.synth = new Synth(this);
    this.synth.out.connect(this.srcSynth);
    this.source = null;
    this.mix = { armed: true, last: null };
  }

  Engine.prototype.setSource = function (name, when) {
    const t = when === undefined ? this.ctx.currentTime : when;
    const trims = { synth: opts.synthTrim, song: opts.songTrim, buffer: opts.songTrim };
    [["synth", this.srcSynth], ["song", this.srcSong], ["buffer", this.srcBuf]].forEach(([n, node]) => {
      setT(node.gain, n === name ? trims[n] : 0, t, n === name ? 0.6 : 0.3);
    });
    // a real recording already has movement: lighter wow
    setT(this.wowDepth.gain, name === "synth" ? 1 : 0.45, t, 0.5);
    this.source = name;
  };

  // apply the journey mix at time `when`. black: 0..1 (how black the screen is)
  Engine.prototype.applyMix = function (p, black, when, first) {
    const m = mixAt(p);
    const b = clamp(black === undefined || black === null ? blackAt(p) : black, 0, 1);
    const st = this.mix;
    const tc = 0.35;

    const drop = smooth(b, 0.75, 0.97); // the bed falls away right at the cut
    const lvl = m.lvl * (1 - 0.4 * b) * (1 - 0.96 * drop);
    const goingDown = st.last ? lvl < st.last.lvl : true;
    setT(this.level.gain, lvl, when, goingDown ? (drop > 0.5 ? 0.03 : 0.08) : 0.4, first);

    setT(this.lp.frequency, m.lp * (1 - 0.7 * b), when, tc, first);
    setT(this.warm.gain, m.warm, when, tc, first);
    setT(this.air.gain, m.air - 4 * b, when, tc, first);
    setT(this.send.gain, m.wet + 0.25 * b, when, tc, first);
    setT(this.dry.gain, 1 - 0.35 * m.wet, when, tc, first);
    setT(this.hiss.gain, 0.0035 * (0.4 + m.hiss) * (1 - 0.5 * drop), when, tc, first);
    setT(this.detune.offset, -opts.synthSlowCents * m.slow, when, 0.8, first);

    // reverse-swell: a wash that rises with the darkness, cut dead at full black
    const cut = smooth(b, 0.9, 0.985);
    setT(this.wash.gain, 0.09 * b * b * (1 - cut), when, cut > 0.5 ? 0.02 : 0.06, first);
    setT(this.washBP.frequency, 300 + 3200 * b * b, when, 0.08, first);

    // sub boom as we fall into the black
    if (b >= 0.95 && st.armed && !first) {
      st.armed = false;
      this.boom(when);
    }
    if (b < 0.4) st.armed = true;

    st.last = { p, b, lvl, slow: m.slow };
    return m;
  };

  Engine.prototype.boom = function (t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(62, t);
    o.frequency.exponentialRampToValueAtTime(33, t + 1.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.28, t + 0.008);
    g.gain.setTargetAtTime(0, t + 0.06, 0.38);
    o.connect(g);
    g.connect(this.boomBus);
    o.start(t);
    o.stop(t + 3);
    // a soft thud on top so it reads on laptop speakers
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 260;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.3, t + 0.004);
    ng.gain.setTargetAtTime(0, t + 0.004, 0.07);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(this.boomBus);
    n.start(t, 2);
    n.stop(t + 0.8);
  };

  // ---------- synthesized SFX ----------

  Engine.prototype.cue = function (name, t, intensity) {
    const fn = CUES[name];
    if (!fn) return false;
    fn(this, t === undefined ? this.ctx.currentTime + 0.005 : t, intensity === undefined ? 1 : intensity);
    return true;
  };

  function burst(eng, t, { f, q, peak, decay, type, len }) {
    const ctx = eng.ctx;
    const n = ctx.createBufferSource();
    n.buffer = eng.white;
    const bp = ctx.createBiquadFilter();
    bp.type = type || "bandpass";
    bp.frequency.value = f;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.0008);
    g.gain.setTargetAtTime(0, t + 0.0008, decay);
    n.connect(bp);
    bp.connect(g);
    g.connect(eng.sfx);
    n.start(t, Math.random() * 0.5);
    n.stop(t + (len || decay * 10));
  }

  function tone(eng, t, { f, f1, type, peak, att, decay, len, dest }) {
    const ctx = eng.ctx;
    const o = ctx.createOscillator();
    o.type = type || "sine";
    o.frequency.setValueAtTime(f, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + (att || 0.001));
    g.gain.setTargetAtTime(0, t + (att || 0.001), decay);
    o.connect(g);
    g.connect(dest || eng.sfx);
    o.start(t);
    o.stop(t + Math.max(len || 0, decay * 8) + 0.05);
    return o;
  }

  // a mechanical click: a 1 ms tick ringing a few small metal/plastic resonances
  function click(eng, t, peak, modes) {
    const ctx = eng.ctx;
    const n = ctx.createBufferSource();
    n.buffer = eng.tick; // the same tick every time: same loudness every take
    const ex = ctx.createGain();
    ex.gain.setValueAtTime(0, t);
    ex.gain.linearRampToValueAtTime(1, t + 0.0003);
    ex.gain.setTargetAtTime(0, t + 0.0003, 0.0012);
    n.connect(ex);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.value = peak;
    ex.connect(hp);
    hp.connect(g);
    modes.forEach(([f, q]) => {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f;
      bp.Q.value = q;
      const bg = ctx.createGain();
      bg.gain.value = q * 0.35;
      ex.connect(bp);
      bp.connect(bg);
      bg.connect(g);
    });
    g.connect(eng.sfx);
    n.start(t);
  }

  const CUES = {
    // 2000s digicam fake shutter: two bright mechanical clicks ("tchk-chk") + a tiny motor whirr
    shutter(eng, t, k) {
      const ctx = eng.ctx;
      // mirror/blade open, then close: plastic body (~1.3 kHz) + small metal parts
      click(eng, t, 0.26 * k, [[1300, 3], [2900, 8], [4700, 12], [6800, 10]]);
      click(eng, t + 0.085, 0.21 * k, [[1100, 3], [2300, 7], [3900, 10]]);
      if (!opts.shutterWhirr) return;
      // motor whirr: filtered noise chopped by the gear teeth, through a small plastic body
      const w0 = t + 0.12;
      const wl = reducedMotion() ? 0.1 : 0.18;
      const n = ctx.createBufferSource();
      n.buffer = eng.white;
      const body = ctx.createBiquadFilter();
      body.type = "bandpass";
      body.frequency.setValueAtTime(3000, w0);
      body.frequency.linearRampToValueAtTime(3600, w0 + wl);
      body.Q.value = 3;
      const teeth = ctx.createOscillator();
      teeth.type = "square";
      teeth.frequency.setValueAtTime(90, w0);
      teeth.frequency.linearRampToValueAtTime(120, w0 + wl);
      const tg = ctx.createGain();
      tg.gain.value = 0.5;
      teeth.connect(tg);
      const am = ctx.createGain();
      am.gain.value = 0.5;
      tg.connect(am.gain);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, w0);
      env.gain.linearRampToValueAtTime(0.045 * k, w0 + 0.03);
      env.gain.setValueAtTime(0.045 * k, w0 + wl - 0.05);
      env.gain.linearRampToValueAtTime(0, w0 + wl);
      n.connect(body);
      body.connect(am);
      am.connect(env);
      env.connect(eng.sfx);
      n.start(w0, 0.2);
      teeth.start(w0);
      n.stop(w0 + wl + 0.05);
      teeth.stop(w0 + wl + 0.05);
      // a last tiny latch
      click(eng, w0 + wl, 0.04 * k, [[3400, 10], [5600, 14]]);
    },

    // AF lock: two short, slightly soft beeps
    beep(eng, t, k) {
      [0, 0.105].forEach((dt) => {
        const s = t + dt;
        const g = eng.ctx.createGain();
        g.gain.setValueAtTime(0, s);
        g.gain.linearRampToValueAtTime(0.11 * k, s + 0.003);
        g.gain.setValueAtTime(0.11 * k, s + 0.06);
        g.gain.linearRampToValueAtTime(0, s + 0.068);
        const lp = eng.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 6000;
        g.connect(lp);
        lp.connect(eng.sfx);
        [[2400, 1], [4800, 0.12], [7200, 0.04]].forEach(([f, a]) => {
          const o = eng.ctx.createOscillator();
          o.frequency.value = f;
          const og = eng.ctx.createGain();
          og.gain.value = a;
          o.connect(og);
          og.connect(g);
          o.start(s);
          o.stop(s + 0.08);
        });
      });
    },

    // flash capacitor charging: a whine that rises fast then settles
    charge(eng, t, k) {
      const ctx = eng.ctx;
      const len = 1.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.03 * k, t + 0.12);
      g.gain.setValueAtTime(0.03 * k, t + len - 0.35);
      g.gain.linearRampToValueAtTime(0, t + len);
      g.connect(eng.sfx);
      const vib = ctx.createOscillator();
      vib.frequency.value = 11;
      const vg = ctx.createGain();
      vg.gain.value = 3;
      vib.connect(vg);
      [[1, "sine", 1], [0.5, "triangle", 0.35]].forEach(([r, type, a]) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(2200 * r, t);
        o.frequency.setTargetAtTime(9800 * r, t, 0.5);
        vg.connect(o.detune);
        const og = ctx.createGain();
        og.gain.value = a;
        o.connect(og);
        og.connect(g);
        o.start(t);
        o.stop(t + len + 0.05);
      });
      vib.start(t);
      vib.stop(t + len + 0.05);
    },

    // power-on chime: a quick rising arpeggio of soft bells
    power(eng, t, k) {
      const notes = [[0, 81, 0.06], [0.085, 86, 0.06], [0.17, 90, 0.055], [0.255, 93, 0.07]];
      notes.forEach(([dt, m, v], i) => {
        bell(eng, eng.sfx, t + dt, mtof(m), v * k, i === notes.length - 1 ? 0.35 : 0.16, false);
      });
    },
  };

  const CUE_GAP = { shutter: 0.25, beep: 0.3, charge: 1.2, power: 0.8 };

  // ---------- the preview (streamed, never stored) ----------

  function silentWavURL() {
    const n = 800;
    const b = new ArrayBuffer(44 + n * 2);
    const v = new DataView(b);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    w(8, "WAVEfmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    w(36, "data");
    v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
  }

  async function lookupSong() {
    try {
      const c = JSON.parse(localStorage.getItem(META_KEY) || "null");
      if (c && c.previewUrl && Date.now() - c.t < 3 * 864e5) return c;
    } catch (e) { /* ignore */ }
    const get = async (url) => {
      const ac = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ac && setTimeout(() => ac.abort(), 6000);
      try {
        const r = await fetch(url, ac ? { signal: ac.signal } : undefined);
        return (await r.json()).results || [];
      } finally {
        clearTimeout(timer);
      }
    };
    const ok = (r) =>
      r && r.previewUrl && SONG.matchTitle.test((r.trackName || "").trim()) && SONG.matchArtist.test(r.artistName || "");
    let hit = (await get(`https://itunes.apple.com/lookup?id=${SONG.id}&entity=song&country=US`)).find(ok);
    if (!hit) {
      const q = encodeURIComponent(SONG.term);
      hit = (await get(`https://itunes.apple.com/search?term=${q}&entity=song&limit=10&country=US`)).find(ok);
    }
    if (!hit) throw new Error("song not found");
    const meta = { previewUrl: hit.previewUrl, trackViewUrl: hit.trackViewUrl || SONG.trackViewUrl, t: Date.now() };
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* ignore */ }
    return meta;
  }

  function SongLoop(eng) {
    this.eng = eng;
    this.els = [0, 1].map(() => {
      const a = new Audio();
      a.crossOrigin = "anonymous"; // Apple's CDN answers with ACAO: * so Web Audio can hear it
      a.preload = "auto";
      a.preservesPitch = false; // slowing should sound like tape, not a time-stretch
      a.mozPreservesPitch = false;
      a.webkitPreservesPitch = false;
      return a;
    });
    this.gains = this.els.map((a) => {
      const g = eng.ctx.createGain();
      g.gain.value = 0;
      eng.ctx.createMediaElementSource(a).connect(g);
      g.connect(eng.srcSong);
      return g;
    });
    this.cur = 0;
    this.url = null;
    this.rate = 1;
    this.rateAt = 0;
    this.playing = false;
    this.fading = false;
    this.timer = null;
    this.silent = null;
  }

  // must run inside the user gesture (Safari): unlock both elements
  SongLoop.prototype.unlock = function () {
    if (this.url) return;
    this.silent = this.silent || silentWavURL();
    this.els.forEach((a) => {
      if (!a.src) a.src = this.silent;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    });
  };

  SongLoop.prototype.play = function (url, onPlaying, onFail) {
    const a = this.els[this.cur];
    const firstTime = this.url !== url;
    this.url = url;
    this.els.forEach((e) => { if (firstTime) e.src = url; });
    this.wantPlay = true;
    this.fading = false;
    this.gains.forEach((g, i) => retarget(g.gain, i === this.cur ? 1 : 0, this.eng.ctx, i === this.cur ? 0.5 : 0.1));
    const fail = setTimeout(() => { if (!this.playing && this.wantPlay) onFail(); }, opts.fallbackAfter);
    a.onplaying = () => {
      clearTimeout(fail);
      if (!this.playing) { this.playing = true; onPlaying(); }
    };
    a.onerror = () => { clearTimeout(fail); onFail(); };
    const p = a.play();
    if (p && p.catch) p.catch(() => { clearTimeout(fail); onFail(); });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 150);
  };

  // loop with an equal-power crossfade before the preview's own fade-out
  SongLoop.prototype.tick = function () {
    if (!this.wantPlay || this.fading) return;
    const a = this.els[this.cur];
    if (!a.duration || !isFinite(a.duration)) return;
    const remain = (a.duration - a.currentTime) / (a.playbackRate || 1);
    if (remain > opts.xfade && !a.ended) return;
    const nxt = 1 - this.cur;
    const b = this.els[nxt];
    b.currentTime = 0;
    b.playbackRate = a.playbackRate;
    const p = b.play();
    if (p && p.catch) p.catch(() => {});
    const ctx = this.eng.ctx;
    const t = ctx.currentTime + 0.02;
    const dur = Math.max(0.3, Math.min(opts.xfade, remain));
    const N = 64;
    const up = new Float32Array(N), down = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      up[i] = Math.sin(x * Math.PI / 2);
      down[i] = Math.cos(x * Math.PI / 2);
    }
    const gA = this.gains[this.cur].gain, gB = this.gains[nxt].gain;
    [gA, gB].forEach((g) => {
      const v = g.value;
      g.cancelScheduledValues(0);
      g.setValueAtTime(v, ctx.currentTime);
    });
    gA.setValueCurveAtTime(down, t, dur);
    gB.setValueCurveAtTime(up, t, dur);
    this.fading = true;
    const run = (this.run = (this.run || 0) + 1);
    setTimeout(() => {
      if (run !== this.run) return; // paused/restarted meanwhile
      a.pause();
      this.cur = nxt;
      this.fading = false;
    }, (dur + 0.1) * 1000);
  };

  // tape-slow at the eye. playbackRate steps aren't ramps, so change it rarely and by tiny steps
  SongLoop.prototype.setSlow = function (slow) {
    const want = Math.round((1 - opts.songSlow * slow) * 200) / 200; // 0.005 steps
    const now = performance.now();
    if (want === this.rate || now - this.rateAt < 450) return;
    this.rate = this.rate + clamp(want - this.rate, -0.005, 0.005);
    this.rateAt = now;
    this.els.forEach((a) => { a.playbackRate = this.rate; });
  };

  SongLoop.prototype.pause = function () {
    this.run = (this.run || 0) + 1;
    this.fading = false;
    this.wantPlay = false;
    this.playing = false;
    clearInterval(this.timer);
    this.els.forEach((a) => a.pause());
  };

  // ---------- realtime state ----------

  let ctx = null;
  let eng = null;
  let song = null;
  let songMeta = null;
  let buffer = null; // load(url)
  let bufNode = null;
  let running = false;
  let muted = false;
  let pending = false; // pref says on, waiting for this visit's first gesture
  let ducked = false;
  let prog = 1; // until the journey says otherwise, the clean mix
  let black = null;
  let lastMix = 0;
  let flushTimer = null;
  let schedTimer = null;
  let songState = "idle"; // idle | loading | playing | failed
  const lastCue = {};
  let want = "song"; // song | synth

  const emit = () => {
    window.dispatchEvent(new CustomEvent("kimaya:sound", { detail: api.state() }));
  };

  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC({ latencyHint: "playback" });
    eng = new Engine(ctx);
    eng.applyMix(prog, black, ctx.currentTime, true);
    eng.meter = ctx.createAnalyser();
    eng.meter.fftSize = 2048;
    eng.out.connect(eng.meter);
    return true;
  }

  function startSynth() {
    if (eng.source !== "synth") eng.setSource("synth");
    if (eng.synth.t0 === null) eng.synth.begin(ctx.currentTime + 0.1);
    clearInterval(schedTimer);
    schedTimer = setInterval(() => eng.synth.schedule(ctx.currentTime + 2), 250);
    eng.synth.schedule(ctx.currentTime + 2);
  }

  function stopSynth() {
    clearInterval(schedTimer);
    schedTimer = null;
    if (eng) eng.synth.halt();
  }

  function startBuffer() {
    if (!bufNode) {
      bufNode = ctx.createBufferSource();
      bufNode.buffer = buffer;
      bufNode.loop = true;
      bufNode.connect(eng.srcBuf);
      bufNode.start();
    }
    eng.setSource("buffer");
  }

  function startSong() {
    if (!song) song = new SongLoop(eng);
    if (songState !== "playing") songState = "loading";
    emit();
    const fail = () => {
      if (songState === "failed" || !running) return;
      songState = "failed";
      song.pause();
      try { localStorage.removeItem(META_KEY); } catch (e) { /* ignore */ }
      if (running && !buffer) startSynth();
      emit();
    };
    const go = (meta) => {
      songMeta = meta;
      if (!running || want !== "song" || buffer) return;
      song.play(meta.previewUrl, () => {
        songState = "playing";
        if (running && want === "song" && !buffer) {
          stopSynth();
          eng.setSource("song");
        }
        emit();
      }, fail);
    };
    if (songMeta) go(songMeta);
    else lookupSong().then(go).catch(fail);
  }

  function pickSource() {
    if (buffer) {
      stopSynth();
      if (song) song.pause();
      startBuffer();
    } else if (want === "song" && songState !== "failed") {
      startSong(); // the pad keeps going (if it was) until the preview actually plays
    } else {
      if (song) song.pause();
      startSynth();
    }
  }

  function flushMix() {
    flushTimer = null;
    if (!eng || !running) return;
    lastMix = performance.now();
    const m = eng.applyMix(prog, black, ctx.currentTime, false);
    if (song && eng.source === "song") song.setSlow(m.slow);
    if (bufNode) bufNode.playbackRate.setTargetAtTime(1 - opts.songSlow * m.slow, ctx.currentTime, 0.8);
  }

  function savePref(on) {
    try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch (e) { /* ignore */ }
  }

  const api = {
    beats,
    opts,

    // call from a user gesture
    start() {
      pending = false;
      savePref(true);
      if (!ensure()) return false;
      const r = ctx.resume();
      if (r && r.catch) r.catch(() => {});
      try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) { /* ignore */ }
      if (want === "song" && !buffer) {
        if (!song) song = new SongLoop(eng);
        song.unlock();
      }
      if (running) return true;
      running = true;
      muted = false;
      if (songState === "failed") songState = "idle"; // every fresh start retries the preview
      const t = ctx.currentTime;
      eng.out.gain.cancelScheduledValues(0);
      eng.out.gain.setValueAtTime(eng.out.gain.value, t);
      eng.out.gain.setTargetAtTime(1, t, 0.6);
      eng.applyMix(prog, black, t, false);
      pickSource();
      api.cue("power");
      emit();
      return true;
    },

    stop() {
      pending = false;
      savePref(false);
      if (!running) { emit(); return; }
      running = false;
      const t = ctx.currentTime;
      eng.out.gain.setTargetAtTime(0, t, 0.12);
      setTimeout(() => {
        if (running) return;
        if (song) song.pause();
        stopSynth();
        ctx.suspend();
      }, 700);
      emit();
    },

    toggle() {
      if (running || pending) api.stop();
      else api.start();
      return running;
    },

    isOn: () => running && !muted,
    isPending: () => pending,

    setMuted(on) {
      muted = !!on;
      if (eng) eng.out.gain.setTargetAtTime(muted || !running ? 0 : 1, ctx.currentTime, 0.12);
      emit();
    },

    // p: journey progress 0..1. o.black: optional, how black the screen is (0..1)
    setProgress(p, o) {
      prog = clamp(+p || 0, 0, 1);
      black = o && typeof o.black === "number" ? o.black : null;
      if (!eng || !running) return;
      const since = performance.now() - lastMix;
      if (since >= 30) flushMix();
      else if (!flushTimer) flushTimer = setTimeout(flushMix, 34 - since);
    },

    cue(name) {
      if (!eng || !running || muted || !CUES[name]) return false;
      const now = ctx.currentTime;
      if (lastCue[name] !== undefined && now - lastCue[name] < (CUE_GAP[name] || 0.2)) return false;
      lastCue[name] = now;
      return eng.cue(name, now + 0.005, reducedMotion() ? 0.5 : 1);
    },

    duck(on) {
      ducked = !!on;
      if (eng) eng.duckG.gain.setTargetAtTime(ducked ? opts.duckTo : 1, ctx.currentTime, ducked ? 0.25 : 0.6);
    },

    // swap in a real (licensed) audio file: decoded, looped, same chain
    async load(url) {
      if (!ensure()) throw new Error("no Web Audio");
      const data = await (await fetch(url)).arrayBuffer();
      const buf = await new Promise((res, rej) => ctx.decodeAudioData(data, res, rej));
      if (bufNode) { try { bufNode.stop(); } catch (e) { /* ignore */ } bufNode = null; }
      buffer = buf;
      if (running) pickSource();
      emit();
      return buf.duration;
    },

    // "song" (preview, falls back to synth) or "synth". a load()ed buffer wins over both.
    useSource(name) {
      want = name === "synth" ? "synth" : "song";
      if (want === "song" && songState === "failed") songState = "idle";
      if (running) pickSource();
      emit();
    },

    configure(o) {
      if (!o) return api;
      if (o.beats) Object.assign(beats, o.beats);
      for (const k in o) if (k !== "beats" && k in opts) opts[k] = o[k];
      if (eng && running) flushMix();
      return api;
    },

    mixAt: (p) => Object.assign(mixAt(p), { black: blackAt(p) }),

    // output level right now, dBFS RMS (dev page meter). -Infinity when silent or not started
    meter() {
      if (!eng || !eng.meter) return -Infinity;
      const d = new Float32Array(eng.meter.fftSize);
      eng.meter.getFloatTimeDomainData(d);
      let e = 0;
      for (const v of d) e += v * v;
      return 10 * Math.log10(e / d.length || 1e-12);
    },

    state() {
      return {
        on: running && !muted,
        running,
        muted,
        pending,
        ducked,
        source: eng ? eng.source : null,
        song: songState,
        songPlaying: running && !muted && songState === "playing" && eng && eng.source === "song",
        credit: { title: SONG.title, artist: SONG.artist, url: (songMeta && songMeta.trackViewUrl) || SONG.trackViewUrl },
        progress: prog,
      };
    },

    // dev/verification: render the procedural bed + cues offline (never touches the speakers)
    // progress/black: number or (t) => number. cues: [{ t, name }]
    async render(o) {
      o = o || {};
      const sr = o.sampleRate || 48000;
      const secs = o.seconds || 30;
      const off = new OfflineAudioContext(2, Math.ceil(sr * secs), sr);
      const e = new Engine(off);
      e.out.gain.value = 1;
      const bed = o.bed !== false;
      if (bed) {
        e.setSource("synth", 0);
        e.srcSynth.gain.setValueAtTime(opts.synthTrim, 0);
        e.synth.begin(0.05);
        e.synth.schedule(secs);
      } else {
        e.level.gain.value = 0;
        e.hiss.gain.value = 0;
      }
      const val = (v, t) => (typeof v === "function" ? v(t) : v);
      if (bed) {
        for (let t = 0, first = true; t < secs; t += 1 / 30, first = false) {
          e.applyMix(val(o.progress === undefined ? 1 : o.progress, t), o.black === undefined ? null : val(o.black, t), t, first);
        }
      }
      (o.cues || []).forEach((c) => e.cue(c.name, c.t, o.reduced ? 0.5 : 1));
      return off.startRendering();
    },

    toWav(buf) {
      const ch = buf.numberOfChannels, n = buf.length;
      const b = new ArrayBuffer(44 + n * ch * 4);
      const v = new DataView(b);
      const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, "RIFF");
      v.setUint32(4, 36 + n * ch * 4, true);
      w(8, "WAVEfmt ");
      v.setUint32(16, 16, true);
      v.setUint16(20, 3, true); // float32
      v.setUint16(22, ch, true);
      v.setUint32(24, buf.sampleRate, true);
      v.setUint32(28, buf.sampleRate * ch * 4, true);
      v.setUint16(32, ch * 4, true);
      v.setUint16(34, 32, true);
      w(36, "data");
      v.setUint32(40, n * ch * 4, true);
      const data = [];
      for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
      let o = 44;
      for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++, o += 4) v.setFloat32(o, data[c][i], true);
      return new Blob([b], { type: "audio/wav" });
    },

    // wire a toggle button (and optional credit link). index.html does this automatically for .j-sound
    bindToggle(btn, credit) {
      if (!btn || btn._kimaya) return;
      btn._kimaya = true;
      const wrap = btn.parentElement;
      const stop = (e) => e.stopPropagation(); // the journey pin opens the booth on click
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        api.toggle();
      });
      if (credit) credit.addEventListener("click", stop);
      const paint = () => {
        const s = api.state();
        const on = s.on || s.pending;
        btn.textContent = on ? "♪ ON" : "♪ OFF";
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        btn.classList.toggle("is-on", s.on);
        btn.classList.toggle("is-pending", s.pending);
        btn.classList.toggle("is-loading", s.on && s.song === "loading");
        if (credit) {
          credit.hidden = !s.songPlaying;
          credit.href = s.credit.url;
          credit.textContent = `♪ ${s.credit.title} — ${s.credit.artist}`;
        }
      };
      window.addEventListener("kimaya:sound", paint);
      paint();
      return wrap;
    },
  };

  // ---------- wiring ----------

  // other song previews on the site: duck under them
  window.addEventListener("kimaya:song", (e) => {
    api.duck(!!(e.detail && e.detail.state === "playing"));
  });

  // pause with the tab
  document.addEventListener("visibilitychange", () => {
    if (!ctx || !running) return;
    if (document.hidden) {
      if (song && eng.source === "song") song.els.forEach((a) => a.pause());
      ctx.suspend();
    } else {
      const r = ctx.resume();
      if (r && r.catch) r.catch(() => {});
      if (song && eng.source === "song" && song.wantPlay) {
        const p = song.els[song.cur].play();
        if (p && p.catch) p.catch(() => {});
      }
    }
  });

  // remembered "on": start at this visit's first real gesture (pointerdown doesn't count on touch)
  const GESTURES = ["pointerup", "click", "keydown", "touchend"];
  function onFirstGesture(e) {
    if (!pending) return disarm();
    // a swipe-scroll touchend isn't an activation: starting then would be "on" but silent
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    if (e.target && e.target.closest && e.target.closest(".j-sound")) return; // the toggle decides
    if (e.type === "keydown" && (e.key === "Escape" || e.key === "Tab")) return;
    disarm();
    api.start();
  }
  function disarm() {
    GESTURES.forEach((n) => window.removeEventListener(n, onFirstGesture, true));
  }

  function init() {
    let pref = null;
    try { pref = localStorage.getItem(PREF_KEY); } catch (e) { /* ignore */ }
    if (pref === "on") {
      pending = true;
      GESTURES.forEach((n) => window.addEventListener(n, onFirstGesture, true));
    }
    document.querySelectorAll(".j-sound").forEach((btn) => {
      const scope = btn.closest(".j-hud, .j-audio") || btn.parentElement;
      api.bindToggle(btn, scope && scope.querySelector(".j-credit"));
    });
    emit();
  }

  window.KimayaSound = api;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
