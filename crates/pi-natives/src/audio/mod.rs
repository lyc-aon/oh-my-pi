//! In-process token sonification backed by the default CPAL output device.
//!
//! The output callback owns its consumer half of a bounded SPSC queue and all
//! DSP state. It never locks, allocates, calls JavaScript, or logs.

mod dsp;

use std::sync::{
	Arc,
	atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering},
};

use cpal::{
	SampleFormat, Stream,
	traits::{DeviceTrait, HostTrait, StreamTrait},
};
use napi_derive::napi;
use parking_lot::Mutex;
use rtrb::{Consumer, Producer, RingBuffer};

use self::dsp::{AudioDsp, DspConfig, PulseBatch};

const COMMAND_QUEUE_CAPACITY: usize = 256;
const MAX_BATCH_PULSES: u32 = 16_384;
const MAX_SPAN_MS: f32 = 60_000.0;
const PREVIEW_DURATION_MS: u32 = 3_200;
const DEMO_DURATION_MS: u32 = 7_000;

/// Audible texture used for token activity.
#[derive(Clone, Copy)]
#[napi(string_enum)]
pub enum SonificationPreset {
	#[napi(value = "rotary")]
	Rotary,
	#[napi(value = "geiger")]
	Geiger,
	#[napi(value = "mechanical")]
	Mechanical,
	#[napi(value = "synth")]
	Synth,
	#[napi(value = "rain")]
	Rain,
}

impl SonificationPreset {
	const fn code(self) -> u8 {
		match self {
			Self::Rotary => 0,
			Self::Geiger => 1,
			Self::Mechanical => 2,
			Self::Synth => 3,
			Self::Rain => 4,
		}
	}
}

/// How strongly the observed token rate changes pulse density.
#[derive(Clone, Copy)]
#[napi(string_enum)]
pub enum SonificationRateResponse {
	#[napi(value = "fixed")]
	Fixed,
	#[napi(value = "subtle")]
	Subtle,
	#[napi(value = "strong")]
	Strong,
}

impl SonificationRateResponse {
	const fn code(self) -> u8 {
		match self {
			Self::Fixed => 0,
			Self::Subtle => 1,
			Self::Strong => 2,
		}
	}
}
/// Semantic stream lane used to give queued pulses a stable source-specific
/// voice.
#[derive(Clone, Copy)]
#[napi(string_enum)]
pub enum SonificationVoice {
	#[napi(value = "assistant")]
	Assistant,
	#[napi(value = "thinking")]
	Thinking,
	#[napi(value = "tool-input")]
	ToolInput,
	#[napi(value = "tool-output")]
	ToolOutput,
	#[napi(value = "tool-success")]
	ToolSuccess,
	#[napi(value = "tool-error")]
	ToolError,
}

impl SonificationVoice {
	const fn code(self) -> u8 {
		match self {
			Self::Assistant => 0,
			Self::Thinking => 1,
			Self::ToolInput => 2,
			Self::ToolOutput => 3,
			Self::ToolSuccess => 4,
			Self::ToolError => 5,
		}
	}
}

/// Runtime configuration for [`TokenAudioEngine`].
#[napi(object)]
pub struct TokenAudioConfig {
	pub preset:        SonificationPreset,
	pub volume:        f64,
	pub rate_response: SonificationRateResponse,
}

/// Current output-stream state.
#[napi(object)]
pub struct TokenAudioStatus {
	pub running:                   bool,
	pub sample_rate:               u32,
	pub channels:                  u32,
	pub error:                     Option<String>,
	pub accepted_batches:          u32,
	pub dropped_command_batches:   u32,
	pub dropped_scheduler_batches: u32,
	pub dropped_pulses:            u32,
	pub peak_scheduler_occupancy:  u32,
}

struct AudioControls {
	preset:         AtomicU8,
	volume:         AtomicU32,
	rate_response:  AtomicU8,
	config_version: AtomicU64,
	clear_epoch:    AtomicU64,
}

impl AudioControls {
	const fn new() -> Self {
		Self {
			preset:         AtomicU8::new(SonificationPreset::Rotary.code()),
			volume:         AtomicU32::new(0.35f32.to_bits()),
			rate_response:  AtomicU8::new(SonificationRateResponse::Subtle.code()),
			config_version: AtomicU64::new(1),
			clear_epoch:    AtomicU64::new(0),
		}
	}

	fn configure(&self, config: TokenAudioConfig) {
		let volume = if config.volume.is_finite() {
			config.volume.clamp(0.0, 1.0) as f32
		} else {
			0.35
		};
		self.preset.store(config.preset.code(), Ordering::Relaxed);
		self.volume.store(volume.to_bits(), Ordering::Relaxed);
		self
			.rate_response
			.store(config.rate_response.code(), Ordering::Relaxed);
		self.config_version.fetch_add(1, Ordering::Release);
	}

	fn config(&self) -> DspConfig {
		DspConfig {
			preset:        self.preset.load(Ordering::Relaxed),
			volume:        f32::from_bits(self.volume.load(Ordering::Relaxed)),
			rate_response: self.rate_response.load(Ordering::Relaxed),
		}
	}
}

struct AudioStatus {
	running:                   AtomicBool,
	stream_failed:             AtomicBool,
	sample_rate:               AtomicU32,
	channels:                  AtomicU32,
	accepted_batches:          AtomicU32,
	dropped_command_batches:   AtomicU32,
	dropped_scheduler_batches: AtomicU32,
	dropped_pulses:            AtomicU32,
	peak_scheduler_occupancy:  AtomicU32,
	error:                     Mutex<Option<String>>,
}

impl AudioStatus {
	const fn new() -> Self {
		Self {
			running:                   AtomicBool::new(false),
			stream_failed:             AtomicBool::new(false),
			sample_rate:               AtomicU32::new(0),
			channels:                  AtomicU32::new(0),
			accepted_batches:          AtomicU32::new(0),
			dropped_command_batches:   AtomicU32::new(0),
			dropped_scheduler_batches: AtomicU32::new(0),
			dropped_pulses:            AtomicU32::new(0),
			peak_scheduler_occupancy:  AtomicU32::new(0),
			error:                     Mutex::new(None),
		}
	}

	fn snapshot(&self) -> TokenAudioStatus {
		let error = if self.stream_failed.load(Ordering::Acquire) {
			Some("Audio output stream failed".to_owned())
		} else {
			self.error.lock().clone()
		};
		TokenAudioStatus {
			running: self.running.load(Ordering::Acquire),
			sample_rate: self.sample_rate.load(Ordering::Relaxed),
			channels: self.channels.load(Ordering::Relaxed),
			error,
			accepted_batches: self.accepted_batches.load(Ordering::Relaxed),
			dropped_command_batches: self.dropped_command_batches.load(Ordering::Relaxed),
			dropped_scheduler_batches: self.dropped_scheduler_batches.load(Ordering::Relaxed),
			dropped_pulses: self.dropped_pulses.load(Ordering::Relaxed),
			peak_scheduler_occupancy: self.peak_scheduler_occupancy.load(Ordering::Relaxed),
		}
	}

	fn reset_metrics(&self) {
		self.accepted_batches.store(0, Ordering::Relaxed);
		self.dropped_command_batches.store(0, Ordering::Relaxed);
		self.dropped_scheduler_batches.store(0, Ordering::Relaxed);
		self.dropped_pulses.store(0, Ordering::Relaxed);
		self.peak_scheduler_occupancy.store(0, Ordering::Relaxed);
	}

	fn record_accepted_batch(&self) {
		self.accepted_batches.fetch_add(1, Ordering::Relaxed);
	}

	fn record_dropped_command_batch(&self, pulses: u32) {
		self.dropped_command_batches.fetch_add(1, Ordering::Relaxed);
		self.dropped_pulses.fetch_add(pulses, Ordering::Relaxed);
	}

	fn record_scheduler_result(&self, occupancy: usize, dropped_pulses: u32) {
		if occupancy == 0 {
			self
				.dropped_scheduler_batches
				.fetch_add(1, Ordering::Relaxed);
			self
				.dropped_pulses
				.fetch_add(dropped_pulses, Ordering::Relaxed);
		} else {
			self
				.peak_scheduler_occupancy
				.fetch_max(occupancy as u32, Ordering::Relaxed);
		}
	}

	fn record_start_error(&self, error: String) {
		*self.error.lock() = Some(error);
		self.running.store(false, Ordering::Release);
	}

	fn record_stream_error(&self) {
		self.stream_failed.store(true, Ordering::Release);
		self.running.store(false, Ordering::Release);
	}

	fn clear_error(&self) {
		*self.error.lock() = None;
		self.stream_failed.store(false, Ordering::Release);
	}
}

struct EngineState {
	stream: Option<Stream>,
}

struct EngineInner {
	controls: Arc<AudioControls>,
	status:   Arc<AudioStatus>,
	producer: Mutex<Option<Producer<PulseBatch>>>,
	state:    Mutex<EngineState>,
}

impl EngineInner {
	fn enqueue(&self, batch: PulseBatch) {
		if let Some(producer) = self.producer.lock().as_mut() {
			if producer.push(batch).is_ok() {
				self.status.record_accepted_batch();
			} else {
				self.status.record_dropped_command_batch(batch.count);
			}
		}
	}

	fn stop(&self) {
		self.status.running.store(false, Ordering::Release);
		self.state.lock().stream.take();
		self.producer.lock().take();
	}
}

struct CallbackState {
	consumer:            Consumer<PulseBatch>,
	controls:            Arc<AudioControls>,
	status:              Arc<AudioStatus>,
	dsp:                 AudioDsp,
	last_config_version: u64,
	last_clear_epoch:    u64,
	channels:            usize,
}

impl CallbackState {
	fn new(
		consumer: Consumer<PulseBatch>,
		controls: Arc<AudioControls>,
		status: Arc<AudioStatus>,
		sample_rate: u32,
		channels: usize,
	) -> Self {
		let config = controls.config();
		Self {
			consumer,
			controls,
			status,
			dsp: AudioDsp::new(sample_rate, config),
			last_config_version: 0,
			last_clear_epoch: 0,
			channels,
		}
	}

	fn begin_buffer(&mut self) {
		let config_version = self.controls.config_version.load(Ordering::Acquire);
		if config_version != self.last_config_version {
			self.dsp.configure(self.controls.config());
			self.last_config_version = config_version;
		}
		let clear_epoch = self.controls.clear_epoch.load(Ordering::Acquire);
		if clear_epoch != self.last_clear_epoch {
			self.dsp.clear();
			self.last_clear_epoch = clear_epoch;
		}
		while let Ok(batch) = self.consumer.pop() {
			if batch.epoch < self.last_clear_epoch {
				continue;
			}
			if batch.epoch > self.last_clear_epoch {
				// The producer observed a clear newer than this callback's
				// initial atomic snapshot. Advance to that boundary now so the
				// post-clear batch is not erased on the next callback.
				self.dsp.clear();
				self.last_clear_epoch = batch.epoch;
			}
			let occupancy = self.dsp.schedule(batch);
			self.status.record_scheduler_result(occupancy, batch.count);
		}
	}

	fn render_f32(&mut self, output: &mut [f32]) {
		self.begin_buffer();
		for frame in output.chunks_exact_mut(self.channels) {
			let sample = self.dsp.next_sample();
			for channel in frame {
				*channel = sample;
			}
		}
	}

	fn render_i16(&mut self, output: &mut [i16]) {
		self.begin_buffer();
		for frame in output.chunks_exact_mut(self.channels) {
			let sample = (self.dsp.next_sample().clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
			for channel in frame {
				*channel = sample;
			}
		}
	}

	fn render_u16(&mut self, output: &mut [u16]) {
		self.begin_buffer();
		for frame in output.chunks_exact_mut(self.channels) {
			let sample =
				(self.dsp.next_sample().clamp(-1.0, 1.0).mul_add(0.5, 0.5) * u16::MAX as f32) as u16;
			for channel in frame {
				*channel = sample;
			}
		}
	}
}

/// In-process real-time audio engine for token sonification.
#[napi]
pub struct TokenAudioEngine {
	inner: EngineInner,
}

impl Default for TokenAudioEngine {
	fn default() -> Self {
		Self::new()
	}
}

#[napi]
impl TokenAudioEngine {
	#[napi(constructor)]
	pub fn new() -> Self {
		Self {
			inner: EngineInner {
				controls: Arc::new(AudioControls::new()),
				status:   Arc::new(AudioStatus::new()),
				producer: Mutex::new(None),
				state:    Mutex::new(EngineState { stream: None }),
			},
		}
	}

	/// Start the default output stream, or update an already-running stream.
	#[napi]
	pub fn start(&self, config: TokenAudioConfig) -> TokenAudioStatus {
		self.inner.controls.configure(config);
		let mut state = self.inner.state.lock();
		if state.stream.is_some() && self.inner.status.running.load(Ordering::Acquire) {
			return self.inner.status.snapshot();
		}
		state.stream.take();
		self.inner.producer.lock().take();

		self.inner.status.clear_error();
		self.inner.status.reset_metrics();
		let (producer, consumer) = RingBuffer::new(COMMAND_QUEUE_CAPACITY);
		*self.inner.producer.lock() = Some(producer);
		match build_default_stream(
			consumer,
			Arc::clone(&self.inner.controls),
			Arc::clone(&self.inner.status),
		) {
			Ok((stream, sample_rate, channels)) => {
				self
					.inner
					.status
					.sample_rate
					.store(sample_rate, Ordering::Relaxed);
				self
					.inner
					.status
					.channels
					.store(channels, Ordering::Relaxed);
				self.inner.status.running.store(true, Ordering::Release);
				state.stream = Some(stream);
			},
			Err(error) => {
				self.inner.producer.lock().take();
				self.inner.status.record_start_error(error);
			},
		}
		self.inner.status.snapshot()
	}

	/// Update the live DSP configuration without recreating the device stream.
	#[napi]
	pub fn configure(&self, config: TokenAudioConfig) {
		self.inner.controls.configure(config);
	}

	/// Queue evenly spaced token pulses over a native-clock time span.
	#[napi]
	pub fn enqueue_pulse_batch(
		&self,
		count: u32,
		span_ms: f64,
		observed_rate: f64,
		voice: SonificationVoice,
	) {
		if count == 0 {
			return;
		}
		let span_ms = finite_f32(span_ms, 1.0).clamp(1.0, MAX_SPAN_MS);
		let observed_rate = finite_f32(observed_rate, 0.0).max(0.0);
		self.inner.enqueue(PulseBatch {
			count: count.min(MAX_BATCH_PULSES),
			span_ms,
			observed_rate,
			delay_ms: 0.0,
			epoch: self.inner.controls.clear_epoch.load(Ordering::Acquire),
			voice: voice.code(),
		});
	}

	/// Queue a slow, medium, then dense audible preview for one preset.
	#[napi]
	pub fn preview(&self, preset: SonificationPreset) -> u32 {
		self
			.inner
			.controls
			.preset
			.store(preset.code(), Ordering::Relaxed);
		self
			.inner
			.controls
			.config_version
			.fetch_add(1, Ordering::Release);
		let epoch = self.inner.controls.clear_epoch.load(Ordering::Acquire);
		for (count, span_ms, observed_rate, delay_ms) in
			[(3, 1_200.0, 3.0, 0.0), (8, 900.0, 12.0, 1_550.0), (22, 500.0, 44.0, 2_700.0)]
		{
			self.inner.enqueue(PulseBatch {
				count,
				span_ms,
				observed_rate,
				delay_ms,
				epoch,
				voice: SonificationVoice::Assistant.code(),
			});
		}
		PREVIEW_DURATION_MS
	}

	/// Queue a deterministic mixed-stream audition trace for one preset.
	#[napi]
	pub fn demo(&self, preset: SonificationPreset) -> u32 {
		self.clear();
		self
			.inner
			.controls
			.preset
			.store(preset.code(), Ordering::Relaxed);
		self
			.inner
			.controls
			.config_version
			.fetch_add(1, Ordering::Release);
		let epoch = self.inner.controls.clear_epoch.load(Ordering::Acquire);
		for (count, span_ms, observed_rate, delay_ms, voice) in [
			(4, 1_200.0, 3.0, 0.0, SonificationVoice::Assistant),
			(18, 900.0, 24.0, 1_450.0, SonificationVoice::Assistant),
			(8, 600.0, 14.0, 2_650.0, SonificationVoice::Thinking),
			(14, 700.0, 22.0, 3_500.0, SonificationVoice::Assistant),
			(12, 600.0, 20.0, 4_450.0, SonificationVoice::ToolInput),
			(16, 700.0, 28.0, 5_250.0, SonificationVoice::ToolOutput),
			(2, 120.0, 16.0, 6_150.0, SonificationVoice::ToolSuccess),
			(2, 120.0, 16.0, 6_600.0, SonificationVoice::ToolError),
		] {
			self.inner.enqueue(PulseBatch {
				count,
				span_ms,
				observed_rate,
				delay_ms,
				epoch,
				voice: voice.code(),
			});
		}
		DEMO_DURATION_MS
	}

	/// Cancel queued and sounding pulses. Repeated calls are harmless.
	#[napi]
	pub fn clear(&self) {
		self
			.inner
			.controls
			.clear_epoch
			.fetch_add(1, Ordering::Release);
	}

	/// Drop the output stream. Repeated calls are harmless.
	#[napi]
	pub fn stop(&self) {
		self.inner.stop();
	}

	#[napi]
	pub fn status(&self) -> TokenAudioStatus {
		self.inner.status.snapshot()
	}
}

fn build_default_stream(
	consumer: Consumer<PulseBatch>,
	controls: Arc<AudioControls>,
	status: Arc<AudioStatus>,
) -> Result<(Stream, u32, u32), String> {
	let device = cpal::default_host()
		.default_output_device()
		.ok_or_else(|| "No default audio output device is available".to_owned())?;
	let supported = device
		.default_output_config()
		.map_err(|error| error.to_string())?;
	let sample_rate = supported.sample_rate().0;
	let channels = u32::from(supported.channels());
	let stream_config = supported.config();
	let make_error_callback =
		|status: Arc<AudioStatus>| move |_error: cpal::StreamError| status.record_stream_error();
	let stream = match supported.sample_format() {
		SampleFormat::F32 => {
			let mut callback = CallbackState::new(
				consumer,
				controls,
				Arc::clone(&status),
				sample_rate,
				channels as usize,
			);
			device.build_output_stream(
				&stream_config,
				move |output: &mut [f32], _| callback.render_f32(output),
				make_error_callback(status),
				None,
			)
		},
		SampleFormat::I16 => {
			let mut callback = CallbackState::new(
				consumer,
				controls,
				Arc::clone(&status),
				sample_rate,
				channels as usize,
			);
			device.build_output_stream(
				&stream_config,
				move |output: &mut [i16], _| callback.render_i16(output),
				make_error_callback(status),
				None,
			)
		},
		SampleFormat::U16 => {
			let mut callback = CallbackState::new(
				consumer,
				controls,
				Arc::clone(&status),
				sample_rate,
				channels as usize,
			);
			device.build_output_stream(
				&stream_config,
				move |output: &mut [u16], _| callback.render_u16(output),
				make_error_callback(status),
				None,
			)
		},
		format => return Err(format!("Unsupported default audio sample format: {format:?}")),
	}
	.map_err(|error| error.to_string())?;
	stream.play().map_err(|error| error.to_string())?;
	Ok((stream, sample_rate, channels))
}

const fn finite_f32(value: f64, fallback: f32) -> f32 {
	if value.is_finite() {
		value as f32
	} else {
		fallback
	}
}

#[cfg(test)]
mod tests {
	use std::sync::{Arc, atomic::Ordering};

	use parking_lot::Mutex;

	use super::{
		AudioControls, AudioStatus, CallbackState, EngineInner, EngineState, PulseBatch, RingBuffer,
		SonificationVoice,
	};

	fn batch(count: u32, epoch: u64) -> PulseBatch {
		PulseBatch {
			count,
			span_ms: 1_000.0,
			observed_rate: 1.0,
			delay_ms: 1_000.0,
			epoch,
			voice: SonificationVoice::Assistant.code(),
		}
	}

	#[test]
	fn post_clear_batch_survives_a_stale_callback_epoch_snapshot() {
		let controls = Arc::new(AudioControls::new());
		let status = Arc::new(AudioStatus::new());
		let (mut producer, consumer) = RingBuffer::new(4);
		let mut callback =
			CallbackState::new(consumer, Arc::clone(&controls), Arc::clone(&status), 48_000, 1);

		let mut post_clear = batch(1, 1);
		post_clear.delay_ms = 0.0;
		producer.push(post_clear).expect("test queue has capacity");
		callback.begin_buffer();
		controls.clear_epoch.store(1, Ordering::Release);
		callback.begin_buffer();

		let mut output = [0.0; 512];
		callback.render_f32(&mut output);
		assert!(output.iter().any(|sample| sample.abs() > f32::EPSILON));
		assert_eq!(controls.clear_epoch.load(Ordering::Acquire), 1);
	}

	#[test]
	fn command_queue_overflow_is_counted() {
		let status = Arc::new(AudioStatus::new());
		let (producer, _consumer) = RingBuffer::new(1);
		let engine = EngineInner {
			controls: Arc::new(AudioControls::new()),
			status:   Arc::clone(&status),
			producer: Mutex::new(Some(producer)),
			state:    Mutex::new(EngineState { stream: None }),
		};

		engine.enqueue(batch(3, 0));
		engine.enqueue(batch(7, 0));

		let snapshot = status.snapshot();
		assert_eq!(snapshot.accepted_batches, 1);
		assert_eq!(snapshot.dropped_command_batches, 1);
		assert_eq!(snapshot.dropped_pulses, 7);
	}

	#[test]
	fn scheduler_saturation_is_counted() {
		let controls = Arc::new(AudioControls::new());
		let status = Arc::new(AudioStatus::new());
		let (mut producer, consumer) = RingBuffer::new(64);
		let mut callback = CallbackState::new(consumer, controls, Arc::clone(&status), 48_000, 1);
		for _ in 0..49 {
			producer.push(batch(2, 0)).expect("test queue has capacity");
		}

		callback.begin_buffer();

		let snapshot = status.snapshot();
		assert_eq!(snapshot.peak_scheduler_occupancy, 48);
		assert_eq!(snapshot.dropped_scheduler_batches, 1);
		assert_eq!(snapshot.dropped_pulses, 2);
	}
}
