//! Allocation-free token-sonification DSP used by the CPAL callback.

const TAU: f32 = std::f32::consts::TAU;
const MAX_SCHEDULED_BATCHES: usize = 48;
const VOICE_COUNT: usize = 6;

#[derive(Clone, Copy)]
pub(super) struct DspConfig {
	pub(super) preset:        u8,
	pub(super) volume:        f32,
	pub(super) rate_response: u8,
}

#[derive(Clone, Copy)]
pub(super) struct PulseBatch {
	pub(super) count:         u32,
	pub(super) span_ms:       f32,
	pub(super) observed_rate: f32,
	pub(super) delay_ms:      f32,
	pub(super) epoch:         u64,
	pub(super) voice:         u8,
}

#[derive(Clone, Copy)]
struct ScheduledBatch {
	remaining:  u32,
	next_frame: u64,
	step:       u64,
	voice:      u8,
}

impl ScheduledBatch {
	const EMPTY: Self = Self { remaining: 0, next_frame: 0, step: 1, voice: 0 };
}

struct PulseScheduler {
	batches: [ScheduledBatch; MAX_SCHEDULED_BATCHES],
}

impl PulseScheduler {
	const fn new() -> Self {
		Self { batches: [ScheduledBatch::EMPTY; MAX_SCHEDULED_BATCHES] }
	}

	const fn clear(&mut self) {
		self.batches = [ScheduledBatch::EMPTY; MAX_SCHEDULED_BATCHES];
	}

	fn schedule(&mut self, batch: PulseBatch, frame: u64, sample_rate: f32, response: u8) -> usize {
		if batch.count == 0 {
			return 0;
		}
		let Some(slot_index) = self.batches.iter().position(|slot| slot.remaining == 0) else {
			return 0;
		};
		let response_scale = match response {
			0 => 1.0,
			1 => (rate_scale(batch.observed_rate) - 1.0).mul_add(0.35, 1.0),
			_ => rate_scale(batch.observed_rate),
		};
		let span_frames = ((batch.span_ms * 0.001 * sample_rate) / response_scale).max(1.0) as u64;
		let step = (span_frames / u64::from(batch.count.saturating_sub(1).max(1))).max(1);
		let delay_frames = (batch.delay_ms * 0.001 * sample_rate).max(0.0) as u64;
		self.batches[slot_index] = ScheduledBatch {
			remaining: batch.count,
			next_frame: frame.saturating_add(delay_frames),
			step,
			voice: batch.voice.min((VOICE_COUNT - 1) as u8),
		};
		self
			.batches
			.iter()
			.filter(|slot| slot.remaining > 0)
			.count()
	}

	fn pulses_at(&mut self, frame: u64) -> [u32; VOICE_COUNT] {
		let mut pulses = [0; VOICE_COUNT];
		for batch in &mut self.batches {
			if batch.remaining > 0 && frame >= batch.next_frame {
				batch.remaining -= 1;
				batch.next_frame = batch.next_frame.saturating_add(batch.step);
				pulses[usize::from(batch.voice)] += 1;
			}
		}
		pulses
	}
}

fn rate_scale(observed_rate: f32) -> f32 {
	(observed_rate / 24.0).clamp(0.45, 2.8)
}

/// Per-stream renderer. It owns only fixed-size state and is safe to keep in
/// the real-time output callback.
pub(super) struct AudioDsp {
	sample_rate:  f32,
	frame:        u64,
	config:       DspConfig,
	scheduler:    PulseScheduler,
	gain:         f32,
	envelope:     f32,
	phase:        f32,
	phase_step:   f32,
	rotor_phase:  f32,
	noise_state:  u32,
	noise_low:    f32,
	noise_lower:  f32,
	alternate:    bool,
	active_voice: u8,
	success_high: bool,
	error_low:    bool,
}

impl AudioDsp {
	pub(super) fn new(sample_rate: u32, config: DspConfig) -> Self {
		let sample_rate = sample_rate.max(1) as f32;
		Self {
			sample_rate,
			frame: 0,
			config,
			scheduler: PulseScheduler::new(),
			gain: 0.0,
			envelope: 0.0,
			phase: 0.0,
			phase_step: TAU * 440.0 / sample_rate,
			rotor_phase: 0.0,
			noise_state: 0xa511_e9b3,
			noise_low: 0.0,
			noise_lower: 0.0,
			alternate: false,
			active_voice: 0,
			success_high: false,
			error_low: false,
		}
	}

	pub(super) const fn configure(&mut self, config: DspConfig) {
		self.config = config;
	}

	pub(super) const fn clear(&mut self) {
		self.scheduler.clear();
		self.envelope = 0.0;
	}

	pub(super) fn schedule(&mut self, batch: PulseBatch) -> usize {
		self
			.scheduler
			.schedule(batch, self.frame, self.sample_rate, self.config.rate_response)
	}

	pub(super) fn next_sample(&mut self) -> f32 {
		for (voice, pulses) in self.scheduler.pulses_at(self.frame).into_iter().enumerate() {
			if pulses > 0 {
				self.trigger(pulses, voice as u8);
			}
		}

		let noise = self.noise();
		self.noise_low = (noise - self.noise_low).mul_add(0.12, self.noise_low);
		self.noise_lower = (self.noise_low - self.noise_lower).mul_add(0.028, self.noise_lower);
		let band_noise = self.noise_low - self.noise_lower;
		let high_noise = noise - self.noise_low;
		self.rotor_phase = wrap_phase(self.rotor_phase + TAU * 18.0 / self.sample_rate);
		self.phase = wrap_phase(self.phase + self.phase_step);

		let preset = self.active_preset();
		let signal = match preset {
			// Rotary: a moving-band noise gate with a low rotor thump.
			0 => {
				self.envelope *= 0.9988;
				let rotor = 0.80f32.mul_add(0.5f32.mul_add(self.rotor_phase.sin(), 0.5), 0.20);
				0.12f32.mul_add(self.phase.sin(), band_noise * rotor * 1.35) * self.envelope
			},
			// Geiger: very short, bright cracks.
			1 => {
				self.envelope *= 0.987;
				0.24f32.mul_add(self.phase.sin(), high_noise * 1.5) * self.envelope
			},
			// Mechanical: alternating resonant knock frequencies.
			2 => {
				self.envelope *= 0.996;
				0.33f32.mul_add((self.phase * 2.03).sin(), self.phase.sin()) * self.envelope
			},
			// Synth: a rounded tonal chirp with a gentle harmonic.
			3 => {
				self.envelope *= 0.9972;
				0.20f32.mul_add((self.phase * 2.0).sin(), self.phase.sin()) * self.envelope
			},
			// Rain: soft, low-passed droplets without a sharp transient.
			_ => {
				self.envelope *= 0.994;
				0.08f32.mul_add(self.phase.sin(), self.noise_lower * 1.5) * self.envelope
			},
		};

		self.gain = (self.config.volume - self.gain).mul_add(0.0018, self.gain);
		self.frame = self.frame.wrapping_add(1);
		soft_limit(signal * self.gain * self.voice_gain())
	}

	fn trigger(&mut self, pulses: u32, voice: u8) {
		self.active_voice = voice;
		let accent = (pulses as f32).min(4.0);
		self.envelope = 0.32f32.mul_add(accent, self.envelope).min(1.0);
		let frequency = match voice {
			2 => {
				self.alternate = !self.alternate;
				if self.alternate { 780.0 } else { 1_180.0 }
			},
			3 => 310.0,
			4 => {
				self.success_high = !self.success_high;
				if self.success_high { 980.0 } else { 1_320.0 }
			},
			5 => {
				self.error_low = !self.error_low;
				if self.error_low { 360.0 } else { 190.0 }
			},
			_ => self.preset_frequency(accent),
		};
		let pitch_scale = if voice == 1 { 0.72 } else { 1.0 };
		self.phase_step = TAU * frequency * pitch_scale / self.sample_rate;
		if self.active_preset() == 3 {
			self.phase_step *= 1.4;
		}
	}

	const fn active_preset(&self) -> u8 {
		match self.active_voice {
			2 | 5 => 2,
			3 => 4,
			4 => 3,
			_ => self.config.preset,
		}
	}

	const fn voice_gain(&self) -> f32 {
		match self.active_voice {
			1 | 2 => 0.65,
			3 => 0.45,
			4 => 0.70,
			5 => 0.75,
			_ => 1.0,
		}
	}

	const fn preset_frequency(&mut self, accent: f32) -> f32 {
		match self.config.preset {
			0 => 20.0f32.mul_add(accent, 150.0),
			1 => 190.0f32.mul_add(accent, 2_100.0),
			2 => {
				self.alternate = !self.alternate;
				if self.alternate { 310.0 } else { 620.0 }
			},
			3 => 120.0f32.mul_add(accent, 920.0),
			_ => 35.0f32.mul_add(accent, 470.0),
		}
	}

	fn noise(&mut self) -> f32 {
		let mut value = self.noise_state;
		value ^= value << 13;
		value ^= value >> 17;
		value ^= value << 5;
		self.noise_state = value;
		(value as f32 * (1.0 / u32::MAX as f32)).mul_add(2.0, -1.0)
	}
}

#[inline]
fn wrap_phase(phase: f32) -> f32 {
	if phase >= TAU { phase - TAU } else { phase }
}

#[inline]
fn soft_limit(sample: f32) -> f32 {
	sample / (1.0 + sample.abs())
}

#[cfg(test)]
mod tests {
	use super::{AudioDsp, DspConfig, PulseBatch, PulseScheduler};

	#[test]
	fn scheduler_places_batch_pulses_at_even_frame_intervals() {
		let mut scheduler = PulseScheduler::new();
		scheduler.schedule(
			PulseBatch {
				count:         3,
				span_ms:       10.0,
				observed_rate: 0.0,
				delay_ms:      0.0,
				epoch:         0,
				voice:         0,
			},
			0,
			1_000.0,
			0,
		);
		assert_eq!(scheduler.pulses_at(0)[0], 1);
		assert_eq!(scheduler.pulses_at(4)[0], 0);
		assert_eq!(scheduler.pulses_at(5)[0], 1);
		assert_eq!(scheduler.pulses_at(9)[0], 0);
		assert_eq!(scheduler.pulses_at(10)[0], 1);
	}

	#[test]
	fn renderer_is_deterministic_for_a_pulse_sequence() {
		let config = DspConfig { preset: 3, volume: 0.7, rate_response: 1 };
		let batch = PulseBatch {
			count:         4,
			span_ms:       40.0,
			observed_rate: 18.0,
			delay_ms:      0.0,
			epoch:         0,
			voice:         0,
		};
		let mut left = AudioDsp::new(48_000, config);
		let mut right = AudioDsp::new(48_000, config);
		left.schedule(batch);
		right.schedule(batch);
		for _ in 0..4_096 {
			assert_eq!(left.next_sample().to_bits(), right.next_sample().to_bits());
		}
	}

	#[test]
	fn every_preset_produces_finite_distinct_audio() {
		let mut fingerprints = [0u64; 5];
		for preset in 0..5 {
			let mut dsp = AudioDsp::new(48_000, DspConfig { preset, volume: 0.8, rate_response: 1 });
			dsp.schedule(PulseBatch {
				count:         8,
				span_ms:       80.0,
				observed_rate: 36.0,
				delay_ms:      0.0,
				epoch:         0,
				voice:         0,
			});
			let mut energy = 0.0;
			let mut fingerprint = 0u64;
			for index in 0..8_192 {
				let sample = dsp.next_sample();
				assert!(sample.is_finite());
				energy += sample.abs();
				fingerprint ^= u64::from(sample.to_bits()).rotate_left(index % 64);
			}
			assert!(energy > 0.01, "preset {preset} rendered silence");
			fingerprints[preset as usize] = fingerprint;
		}
		for left in 0..fingerprints.len() {
			for right in left + 1..fingerprints.len() {
				assert_ne!(fingerprints[left], fingerprints[right]);
			}
		}
	}

	#[test]
	fn every_voice_produces_finite_distinct_audio() {
		let mut fingerprints = [0u64; 6];
		for voice in 0..6 {
			let mut dsp = AudioDsp::new(48_000, DspConfig {
				preset:        2,
				volume:        0.8,
				rate_response: 1,
			});
			dsp.schedule(PulseBatch {
				count: 8,
				span_ms: 80.0,
				observed_rate: 36.0,
				delay_ms: 0.0,
				epoch: 0,
				voice,
			});
			let mut energy = 0.0;
			let mut fingerprint = 0u64;
			for index in 0..8_192 {
				let sample = dsp.next_sample();
				assert!(sample.is_finite());
				energy += sample.abs();
				fingerprint ^= u64::from(sample.to_bits()).rotate_left(index % 64);
			}
			assert!(energy > 0.01, "voice {voice} rendered silence");
			fingerprints[voice as usize] = fingerprint;
		}
		for left in 0..fingerprints.len() {
			for right in left + 1..fingerprints.len() {
				assert_ne!(fingerprints[left], fingerprints[right]);
			}
		}
	}

	#[test]
	fn clear_cancels_scheduled_and_sounding_pulses_immediately() {
		let mut dsp = AudioDsp::new(48_000, DspConfig {
			preset:        0,
			volume:        0.8,
			rate_response: 1,
		});
		dsp.schedule(PulseBatch {
			count:         20,
			span_ms:       1_000.0,
			observed_rate: 20.0,
			delay_ms:      0.0,
			epoch:         0,
			voice:         0,
		});
		for _ in 0..256 {
			let _ = dsp.next_sample();
		}
		dsp.clear();
		for _ in 0..2_048 {
			assert_eq!(dsp.next_sample(), 0.0);
		}
	}
}
