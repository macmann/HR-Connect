function isTruthy(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function getAiVoiceInterviewConfig() {
  const featureFlagEnabled =
    isTruthy(process.env.AI_VOICE_INTERVIEW_ENABLED) ||
    isTruthy(process.env.ENABLE_AI_VOICE_INTERVIEW) ||
    isTruthy(process.env.AI_REALTIME_ENABLED);

  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);
  const enabled = featureFlagEnabled && hasOpenAiKey;

  return {
    enabled,
    featureFlagEnabled,
    hasOpenAiKey
  };
}

function getAiVoiceInterviewRealtimeConfig() {
  return {
    model: process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17',
    voice: process.env.OPENAI_REALTIME_VOICE || 'alloy',
    transcriptionModel: process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    maxDurationSec: Number(process.env.PUBLIC_AI_REALTIME_MAX_DURATION_SEC || 600),
    allowInterruptions: isTruthy(process.env.PUBLIC_AI_REALTIME_ALLOW_INTERRUPTION ?? 'true')
  };
}

function isAiVoiceInterviewEnabled() {
  return getAiVoiceInterviewConfig().enabled;
}

module.exports = {
  getAiVoiceInterviewConfig,
  getAiVoiceInterviewRealtimeConfig,
  isAiVoiceInterviewEnabled
};
