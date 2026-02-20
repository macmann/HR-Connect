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

function isAiVoiceInterviewEnabled() {
  return getAiVoiceInterviewConfig().enabled;
}

module.exports = {
  getAiVoiceInterviewConfig,
  isAiVoiceInterviewEnabled
};
