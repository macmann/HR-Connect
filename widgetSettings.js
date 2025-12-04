const { init, getDatabase } = require('./db');

const DEFAULT_CHAT_WIDGET_SETTINGS = {
  enabled: true,
  url: 'https://qa.atenxion.ai/chat-widget?agentchainId=6900712037c0ed036821b334'
};

const CHAT_WIDGET_CACHE_MS = 60 * 1000;
let chatWidgetCache = { value: null, loadedAt: 0 };

function normalizeChatWidgetSettings(raw = {}) {
  const source = raw && typeof raw.value === 'object' ? raw.value : raw;
  const enabled = Boolean(source.enabled);
  let url = typeof source.url === 'string' ? source.url.trim() : '';

  if (url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        url = '';
      }
    } catch (err) {
      url = '';
    }
  }

  if (!url) {
    url = DEFAULT_CHAT_WIDGET_SETTINGS.url;
  }

  return { enabled, url };
}

async function loadChatWidgetSettings({ force = false } = {}) {
  const now = Date.now();
  if (!force && chatWidgetCache.value && now - chatWidgetCache.loadedAt < CHAT_WIDGET_CACHE_MS) {
    return chatWidgetCache.value;
  }

  await init();
  const database = getDatabase();
  const doc = await database.collection('settings').findOne({ _id: 'chat_widget' });
  const normalized = normalizeChatWidgetSettings(doc || {});
  chatWidgetCache = { value: normalized, loadedAt: now };
  return normalized;
}

async function saveChatWidgetSettings(settings = {}) {
  await init();
  const database = getDatabase();
  const normalized = normalizeChatWidgetSettings(settings);

  await database.collection('settings').updateOne(
    { _id: 'chat_widget' },
    { $set: { value: normalized } },
    { upsert: true }
  );

  chatWidgetCache = { value: normalized, loadedAt: Date.now() };
  return normalized;
}

module.exports = {
  DEFAULT_CHAT_WIDGET_SETTINGS,
  loadChatWidgetSettings,
  saveChatWidgetSettings,
  normalizeChatWidgetSettings
};
