//! Speaks text with a Phonon checkpoint and streams the audio to stdout.
//!
//! The checkpoint folder holds `config.json`, `tokenizer.json`, `model.safetensors` (or
//! `model.q8.gguf`) and its voices in `voices/`. Thread count comes from `RAYON_NUM_THREADS`.
//!
//! stdin: one JSON request per line.
//!   {"op":"speak","id":7,"text":"Hello."}   queue an utterance
//!   {"op":"stop","id":7}                     stop utterance 7 (0 stops everything)
//!   {"op":"fx","on":false}                   turn the Techno audio effect off or on
//! stdout: frames of `[u32 length][u8 kind][u32 id][payload]`, little-endian, where length counts
//! kind, id and payload.
//!   kind 1 ready  payload: JSON {"sampleRate":24000,"voices":[...]}
//!   kind 2 audio  payload: f32 samples at the sample rate
//!   kind 3 done   payload: JSON {"samples":n,"ttfaMs":x,"totalMs":y,"stopped":bool}
//!   kind 4 error  payload: UTF-8 message

mod fx;

use fx::VoiceFx;
use ptts::checkpoint::read_config;
use ptts::preprocess::Normalize;
use ptts::synth::{DeviceKind, Quant, SpeechOptions, Synth, SynthBuilder};
use serde::Deserialize;
use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

const READY: u8 = 1;
const AUDIO: u8 = 2;
const DONE: u8 = 3;
const ERROR: u8 = 4;
const WEIGHTS: [(&str, Quant); 2] =
    [("model.q8.gguf", Quant::Q80), ("model.safetensors", Quant::F32)];

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Speak { id: u32, text: String },
    Stop { id: u32 },
    Fx { on: bool },
}

struct Args {
    model: PathBuf,
    voice: Option<String>,
    lang: String,
    temperature: f32,
    seed: u64,
    fx: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        model: PathBuf::new(),
        voice: None,
        lang: "en".into(),
        temperature: 0.3,
        seed: 4242424242424242,
        fx: true,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let value = it.next().ok_or(format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--model" => args.model = PathBuf::from(value),
            "--voice" => args.voice = Some(value),
            "--lang" => args.lang = value,
            "--temperature" => args.temperature = value.parse().map_err(|_| "bad --temperature")?,
            "--seed" => args.seed = value.parse().map_err(|_| "bad --seed")?,
            "--fx" => args.fx = value != "off",
            _ => return Err(format!("unknown flag {flag}")),
        }
    }
    if args.model.as_os_str().is_empty() {
        return Err("--model is required".into());
    }
    Ok(args)
}

fn load(dir: &Path) -> Result<Synth, String> {
    let cfg = read_config(&dir.join("config.json")).map_err(|e| e.to_string())?;
    let (weights, quant) = WEIGHTS
        .iter()
        .map(|&(name, q)| (dir.join(name), q))
        .find(|(p, _)| p.is_file())
        .ok_or_else(|| format!("no model weights in {}", dir.display()))?;
    let mut builder = SynthBuilder::new(cfg, weights, Normalize::OFF)
        .tokenizer_file(dir.join("tokenizer.json"))
        .device(DeviceKind::Cpu)
        .quant(quant);
    for (name, path) in ptts::loader::checkpoint_voices(dir) {
        builder = builder.add_voice(name, path);
    }
    builder.build().map_err(|e| e.to_string())
}

struct Out(std::io::StdoutLock<'static>);

impl Out {
    fn frame(&mut self, kind: u8, id: u32, payload: &[u8]) -> bool {
        let len = (1 + 4 + payload.len()) as u32;
        let ok = self.0.write_all(&len.to_le_bytes()).is_ok()
            && self.0.write_all(&[kind]).is_ok()
            && self.0.write_all(&id.to_le_bytes()).is_ok()
            && self.0.write_all(payload).is_ok()
            && self.0.flush().is_ok();
        ok
    }

    fn audio(&mut self, id: u32, pcm: &[f32]) -> bool {
        let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.frame(AUDIO, id, &bytes)
    }
}

#[derive(Default)]
struct Queue {
    jobs: VecDeque<(u32, String)>,
    closed: bool,
}

/// `--fx-test <in.f32> <out.f32> <chunk>`: runs raw audio through the effect in chunks, then its
/// tail, so the port can be compared against the reference implementation.
fn fx_test(args: &[String]) {
    let input = std::fs::read(&args[0]).expect("read input");
    let samples: Vec<f32> =
        input.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let chunk: usize = args[2].parse().expect("chunk size");
    let mut fx = VoiceFx::new();
    let mut out: Vec<f32> = Vec::new();
    for part in samples.chunks(chunk) {
        out.extend(fx.process(part));
    }
    out.extend(fx.drain(0.5));
    let bytes: Vec<u8> = out.iter().flat_map(|s| s.to_le_bytes()).collect();
    std::fs::write(&args[1], bytes).expect("write output");
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(String::as_str) == Some("--fx-test") {
        fx_test(&argv[2..]);
        return;
    }
    let mut out = Out(std::io::stdout().lock());
    let args = match parse_args() {
        Ok(args) => args,
        Err(e) => {
            out.frame(ERROR, 0, e.as_bytes());
            std::process::exit(2);
        }
    };
    let normalize = match args.lang.parse::<Normalize>() {
        Ok(n) => n,
        Err(e) => {
            out.frame(ERROR, 0, e.to_string().as_bytes());
            std::process::exit(2);
        }
    };
    let synth = match load(&args.model) {
        Ok(s) => s,
        Err(e) => {
            out.frame(ERROR, 0, e.as_bytes());
            std::process::exit(1);
        }
    };
    let voices = synth.voices();
    let voice = args.voice.clone().or_else(|| synth.default_voice());
    if let Some(v) = &voice {
        if !voices.contains(v) {
            out.frame(ERROR, 0, format!("voice {v} not in {voices:?}").as_bytes());
            std::process::exit(1);
        }
    }
    let opts = SpeechOptions {
        voice,
        temperature: Some(args.temperature),
        seed: Some(args.seed),
        ..Default::default()
    };
    // The first utterance pays for allocations and caches; do it before reporting ready.
    if let Ok(stream) = synth.stream_with(&normalize.apply("Ready."), &opts) {
        for _ in stream {}
    }
    let ready = serde_json::json!({ "sampleRate": synth.sample_rate(), "voices": voices });
    if !out.frame(READY, 0, ready.to_string().as_bytes()) {
        return;
    }

    let queue = Arc::new((Mutex::new(Queue::default()), Condvar::new()));
    // Id of the utterance being spoken; a stop for it (or for 0) sets `cancel` to that id.
    let current = Arc::new(AtomicU32::new(0));
    let cancel = Arc::new(AtomicU32::new(0));
    let fx_on = Arc::new(AtomicBool::new(args.fx));
    {
        let (queue, current, cancel, fx_on) =
            (queue.clone(), current.clone(), cancel.clone(), fx_on.clone());
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                let Ok(request) = serde_json::from_str::<Request>(&line) else { continue };
                let (lock, cv) = &*queue;
                let mut q = lock.lock().unwrap();
                match request {
                    Request::Speak { id, text } => q.jobs.push_back((id, text)),
                    Request::Fx { on } => fx_on.store(on, Ordering::SeqCst),
                    Request::Stop { id } => {
                        q.jobs.retain(|(job, _)| id != 0 && *job != id);
                        let speaking = current.load(Ordering::SeqCst);
                        if speaking != 0 && (id == 0 || id == speaking) {
                            cancel.store(speaking, Ordering::SeqCst);
                        }
                    }
                }
                cv.notify_one();
            }
            let (lock, cv) = &*queue;
            lock.lock().unwrap().closed = true;
            cv.notify_one();
        });
    }

    let mut fx = VoiceFx::new();
    loop {
        let (id, text) = {
            let (lock, cv) = &*queue;
            let mut q = lock.lock().unwrap();
            loop {
                if let Some(job) = q.jobs.pop_front() {
                    break job;
                }
                if q.closed {
                    return;
                }
                q = cv.wait(q).unwrap();
            }
        };
        current.store(id, Ordering::SeqCst);
        let start = Instant::now();
        let (mut samples, mut ttfa, mut stopped) = (0usize, None, false);
        let result = synth.stream_with(&normalize.apply(&text), &opts).map(|stream| {
            for pcm in stream {
                if cancel.load(Ordering::SeqCst) == id {
                    stopped = true;
                    break;
                }
                let pcm = match pcm {
                    Ok(pcm) => pcm,
                    Err(e) => return Err(e.to_string()),
                };
                if pcm.is_empty() {
                    continue;
                }
                ttfa.get_or_insert(start.elapsed());
                samples += pcm.len();
                let pcm = if fx_on.load(Ordering::SeqCst) {
                    fx.process(&pcm)
                } else {
                    if fx.tail_live() {
                        fx.reset();
                    }
                    pcm
                };
                if !out.audio(id, &pcm) {
                    std::process::exit(0);
                }
            }
            Ok(())
        });
        current.store(0, Ordering::SeqCst);
        let _ = cancel.compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst);
        // The reverb tail rings out only when nothing follows; the next sentence carries it on.
        if stopped {
            fx.reset();
        } else if fx.tail_live() && queue.0.lock().unwrap().jobs.is_empty() {
            let tail = fx.drain(0.5);
            for part in tail.chunks(2400) {
                if !out.audio(id, part) {
                    std::process::exit(0);
                }
            }
        }
        match result.map_err(|e| e.to_string()).and_then(|r| r) {
            Ok(()) => {
                let done = serde_json::json!({
                    "samples": samples,
                    "ttfaMs": ttfa.unwrap_or_default().as_secs_f64() * 1e3,
                    "totalMs": start.elapsed().as_secs_f64() * 1e3,
                    "stopped": stopped,
                });
                out.frame(DONE, id, done.to_string().as_bytes());
            }
            Err(e) => {
                out.frame(ERROR, id, e.as_bytes());
            }
        }
    }
}
