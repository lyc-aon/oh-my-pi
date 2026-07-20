//! Compile-safe token-sonification surface for platforms without the realtime
//! backend.

use napi_derive::napi;

const UNAVAILABLE_MESSAGE: &str = "Token sonification is unavailable on this platform";

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

#[napi(object)]
pub struct TokenAudioConfig {
	pub preset:        SonificationPreset,
	pub volume:        f64,
	pub rate_response: SonificationRateResponse,
}

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

#[napi]
pub struct TokenAudioEngine;

impl Default for TokenAudioEngine {
	fn default() -> Self {
		Self::new()
	}
}

#[napi]
impl TokenAudioEngine {
	#[napi(constructor)]
	pub const fn new() -> Self {
		Self
	}

	#[napi]
	pub fn start(&self, _config: TokenAudioConfig) -> TokenAudioStatus {
		self.status()
	}

	#[napi]
	pub const fn configure(&self, _config: TokenAudioConfig) {}

	#[napi]
	pub const fn enqueue_pulse_batch(
		&self,
		_count: u32,
		_span_ms: f64,
		_observed_rate: f64,
		_voice: SonificationVoice,
	) {
	}

	#[napi]
	pub const fn preview(&self, _preset: SonificationPreset) -> u32 {
		0
	}

	#[napi]
	pub const fn demo(&self, _preset: SonificationPreset) -> u32 {
		0
	}

	#[napi]
	pub const fn clear(&self) {}

	#[napi]
	pub const fn stop(&self) {}

	#[napi]
	pub fn status(&self) -> TokenAudioStatus {
		TokenAudioStatus {
			running:                   false,
			sample_rate:               0,
			channels:                  0,
			error:                     Some(UNAVAILABLE_MESSAGE.to_owned()),
			accepted_batches:          0,
			dropped_command_batches:   0,
			dropped_scheduler_batches: 0,
			dropped_pulses:            0,
			peak_scheduler_occupancy:  0,
		}
	}
}
