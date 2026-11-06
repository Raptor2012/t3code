//! The "Techno audio effect" on Maeve's voice: body and presence EQ, broadcast density,
//! micro-reflections, light doubling and a short speech-ducked plate. A line-for-line port of
//! the standalone orb's numpy `VoiceFx`; `fx/voicefx.f32` holds its EQ and reverb kernels, which
//! `fx/generate.py` writes from that implementation (the reverb comes from numpy's seeded RNG).

use realfft::{RealFftPlanner, num_complex::Complex};
use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::Arc;

const RATE: f64 = 24000.0;
const WET: f64 = 0.35;
const CHORUS: f64 = 0.23;
const COMB: f64 = 0.12;
const RING: f64 = 0.025;
const RING_HZ: f64 = 96.0;
const SHEEN: f64 = 0.28;
const KERNELS: &[u8] = include_bytes!("../fx/voicefx.f32");

/// Streaming FFT convolution; chunked output equals one-shot output.
struct OverlapAdd {
    kernel: Vec<f64>,
    tail: Vec<f64>,
    planner: RealFftPlanner<f64>,
    spectra: HashMap<usize, Arc<Vec<Complex<f64>>>>,
}

impl OverlapAdd {
    fn new(kernel: Vec<f64>) -> Self {
        let tail = vec![0.0; kernel.len() - 1];
        Self { kernel, tail, planner: RealFftPlanner::new(), spectra: HashMap::new() }
    }

    fn reset(&mut self) {
        self.tail.iter_mut().for_each(|v| *v = 0.0);
    }

    fn process(&mut self, x: &[f64]) -> Vec<f64> {
        let n = x.len();
        let full = n + self.kernel.len() - 1;
        let size = full.next_power_of_two();
        let forward = self.planner.plan_fft_forward(size);
        let inverse = self.planner.plan_fft_inverse(size);
        let kernel = self
            .spectra
            .entry(size)
            .or_insert_with(|| {
                let mut input = vec![0.0; size];
                input[..self.kernel.len()].copy_from_slice(&self.kernel);
                let mut spectrum = forward.make_output_vec();
                forward.process(&mut input, &mut spectrum).expect("fft");
                Arc::new(spectrum)
            })
            .clone();
        let mut input = vec![0.0; size];
        input[..n].copy_from_slice(x);
        let mut spectrum = forward.make_output_vec();
        forward.process(&mut input, &mut spectrum).expect("fft");
        for (s, k) in spectrum.iter_mut().zip(kernel.iter()) {
            *s *= *k;
        }
        let mut y = inverse.make_output_vec();
        inverse.process(&mut spectrum, &mut y).expect("ifft");
        let scale = 1.0 / size as f64;
        y.truncate(full);
        for v in y.iter_mut() {
            *v *= scale;
        }
        for (v, t) in y.iter_mut().zip(self.tail.iter()) {
            *v += *t;
        }
        // numpy keeps the tail as float32 between calls.
        self.tail = y[n..].iter().map(|v| *v as f32 as f64).collect();
        y.truncate(n);
        y
    }
}

/// numpy.interp over integer sample positions, clamped at both ends.
fn interp(at: f64, buf: &[f64]) -> f64 {
    if at <= 0.0 {
        return buf[0];
    }
    let last = (buf.len() - 1) as f64;
    if at >= last {
        return buf[buf.len() - 1];
    }
    let i = at.floor() as usize;
    let f = at - i as f64;
    buf[i] + (buf[i + 1] - buf[i]) * f
}

pub struct VoiceFx {
    eq: OverlapAdd,
    reverb: OverlapAdd,
    history: Vec<f64>,
    pos: u64,
    envelope: f64,
    attack: f64,
    release: f64,
    drained: usize,
    tail_live: bool,
}

impl VoiceFx {
    pub fn new() -> Self {
        let floats: Vec<f32> = KERNELS
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        let (eq_len, ir_len) = (floats[0] as usize, floats[1] as usize);
        let eq = floats[2..2 + eq_len].iter().map(|v| *v as f64).collect();
        let ir = floats[2 + eq_len..2 + eq_len + ir_len].iter().map(|v| *v as f64).collect();
        Self {
            eq: OverlapAdd::new(eq),
            reverb: OverlapAdd::new(ir),
            history: vec![0.0; (0.03 * RATE) as usize],
            pos: 0,
            envelope: 0.0,
            attack: (-1.0 / (0.003 * RATE)).exp(),
            release: (-1.0 / (0.075 * RATE)).exp(),
            drained: 0,
            tail_live: false,
        }
    }

    pub fn reset(&mut self) {
        self.eq.reset();
        self.reverb.reset();
        self.history.iter_mut().for_each(|v| *v = 0.0);
        self.pos = 0;
        self.envelope = 0.0;
        self.drained = 0;
        self.tail_live = false;
    }

    pub fn tail_live(&self) -> bool {
        self.tail_live
    }

    pub fn process(&mut self, chunk: &[f32]) -> Vec<f32> {
        let n = chunk.len();
        if n == 0 {
            return Vec::new();
        }
        let input: Vec<f64> = chunk.iter().map(|v| *v as f64).collect();
        // numpy runs the EQ in float64 and stores x as float32 again only at the gain step.
        let x = self.eq.process(&input);
        let mut envelope = vec![0.0f64; n];
        let mut level = self.envelope;
        for (i, sample) in x.iter().enumerate() {
            let value = sample.abs();
            let coefficient = if value > level { self.attack } else { self.release };
            level = value + coefficient * (level - value);
            envelope[i] = level as f32 as f64;
        }
        self.envelope = level;
        let x: Vec<f64> = x
            .iter()
            .zip(envelope.iter())
            .map(|(v, e)| {
                // numpy evaluates the gain in float32 (the envelope's dtype), then scales float64.
                let e = *e as f32;
                let gain = 1.32f32 * f32::min(1.0, (0.17f32 / e.max(1e-8)).powf(0.48));
                v * gain as f64
            })
            .collect();
        let h = self.history.len();
        let mut buf = Vec::with_capacity(h + n);
        buf.extend_from_slice(&self.history);
        buf.extend_from_slice(&x);
        let mut mixed = vec![0.0f64; n];
        let norm = 1.0 + COMB * 0.45 + SHEEN * 0.2 + CHORUS * 0.25;
        for i in 0..n {
            let t = (self.pos + i as u64) as f64 / RATE;
            let at = (h + i) as f64;
            let comb_d = (0.00145 + 0.00015 * (2.0 * PI * 0.21 * t).sin()) * RATE;
            let d1 = (0.0105 + 0.00045 * (2.0 * PI * 0.33 * t).sin()) * RATE;
            let d2 = (0.0175 + 0.00065 * (2.0 * PI * 0.51 * t + 1.3).sin()) * RATE;
            let sheen =
                0.5 * (interp(at - 0.0032 * RATE, &buf) - interp(at - 0.0047 * RATE, &buf));
            let mut y = x[i]
                + SHEEN * sheen
                + COMB * interp(at - comb_d, &buf)
                + CHORUS * 0.5 * (interp(at - d1, &buf) + interp(at - d2, &buf));
            y /= norm;
            y *= 1.0 - RING + RING * (2.0 * PI * RING_HZ * t).sin();
            mixed[i] = (0.72 * y + 0.28 * (1.8 * y).tanh() / 1.8) as f32 as f64;
        }
        let wet = self.reverb.process(&mixed);
        self.history = buf[buf.len() - h..].iter().map(|v| *v as f32 as f64).collect();
        self.pos += n as u64;
        self.drained = 0;
        self.tail_live = true;
        mixed
            .iter()
            .zip(wet.iter())
            .zip(envelope.iter())
            .map(|((y, w), e)| {
                let duck = (1.0f32 + 1.8f32 * *e as f32) as f64;
                let mix = y + WET * w / duck;
                (0.92 * (mix / 0.92).tanh()) as f32
            })
            .collect()
    }

    /// The reverb tail after speech ends: silence through the effect, faded out over `fade`
    /// seconds, then a reset. Returns nothing when no speech went through since the last reset.
    pub fn drain(&mut self, fade: f64) -> Vec<f32> {
        if !self.tail_live {
            return Vec::new();
        }
        let duration = ((fade * RATE) as usize).max(1);
        let mut out = Vec::with_capacity(duration);
        let step = (0.05 * RATE) as usize;
        while self.drained < duration {
            let start = self.drained;
            let part = self.process(&vec![0.0; step]);
            for (i, sample) in part.iter().enumerate() {
                let phase = ((start + i) as f64 / (duration.max(2) - 1) as f64).clamp(0.0, 1.0);
                out.push(sample * (0.5 + 0.5 * (PI * phase).cos()) as f32);
            }
            self.drained = start + step;
        }
        self.reset();
        out
    }
}
