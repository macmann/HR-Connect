const ONEDRIVE_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProvider(value) {
  return normalizeString(value).toLowerCase();
}

function parseYouTubeVideoId(value) {
  const input = normalizeString(value);
  if (!input) return '';

  try {
    const parsed = new URL(input);
    if (parsed.hostname.includes('youtu.be')) {
      return normalizeString(parsed.pathname.split('/').filter(Boolean)[0]);
    }
    if (parsed.hostname.includes('youtube.com')) {
      const videoId = parsed.searchParams.get('v');
      if (videoId) return normalizeString(videoId);
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      const embedIndex = pathParts.indexOf('embed');
      if (embedIndex !== -1 && pathParts[embedIndex + 1]) {
        return normalizeString(pathParts[embedIndex + 1]);
      }
    }
  } catch (error) {
    if (/^[\w-]{11}$/.test(input)) {
      return input;
    }
  }

  return '';
}

function buildYouTubeEmbedMetadata(videoId, metadata = {}) {
  const normalizedId = parseYouTubeVideoId(videoId);
  if (!normalizedId) return null;

  return {
    videoId: normalizedId,
    embedUrl: `https://www.youtube.com/embed/${normalizedId}`,
    thumbnailUrl:
      normalizeString(metadata.thumbnailUrl) ||
      `https://img.youtube.com/vi/${normalizedId}/hqdefault.jpg`
  };
}

function resolveOneDriveLinkEndpoint(oneDrive = {}) {
  const shareId = normalizeString(oneDrive.shareId);
  if (shareId) {
    return `/shares/${encodeURIComponent(shareId)}/driveItem/createLink`;
  }

  const driveId = normalizeString(oneDrive.driveId);
  const itemId = normalizeString(oneDrive.itemId);
  if (driveId && itemId) {
    return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/createLink`;
  }

  return '';
}

async function generateOneDriveStreamingLink(oneDrive = {}) {
  const endpoint = resolveOneDriveLinkEndpoint(oneDrive);
  const token =
    process.env.ONEDRIVE_GRAPH_TOKEN ||
    process.env.MS_GRAPH_TOKEN ||
    '';
  const skipCreateLink =
    normalizeString(process.env.ONEDRIVE_SKIP_CREATE_LINK).toLowerCase() === 'true';

  if (skipCreateLink) {
    return { streamUrl: null, expiresAt: null, error: 'onedrive_stream_skipped' };
  }

  if (!endpoint || !token) {
    return { streamUrl: null, expiresAt: null, error: 'onedrive_stream_unavailable' };
  }

  const ttlSeconds = Number(process.env.ONEDRIVE_STREAM_URL_TTL_SECONDS || 900);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  try {
    const response = await fetch(`${ONEDRIVE_GRAPH_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'view',
        scope: 'anonymous',
        expirationDateTime: expiresAt
      })
    });

    if (!response.ok) {
      return {
        streamUrl: null,
        expiresAt: null,
        error: `onedrive_stream_failed_${response.status}`
      };
    }

    const payload = await response.json();
    const streamUrl = normalizeString(payload?.link?.webUrl);
    return {
      streamUrl: streamUrl || null,
      expiresAt: payload?.expirationDateTime || expiresAt,
      error: streamUrl ? null : 'onedrive_stream_missing_url'
    };
  } catch (error) {
    return { streamUrl: null, expiresAt: null, error: 'onedrive_stream_failed' };
  }
}

function extractSafeMetadata(metadata = {}) {
  const oneDrive = metadata.oneDrive && typeof metadata.oneDrive === 'object'
    ? {
        webUrl: normalizeString(metadata.oneDrive.webUrl)
      }
    : null;

  return {
    oneDrive,
    mimeType: normalizeString(metadata.mimeType),
    fileName: normalizeString(metadata.fileName),
    fileSize: Number.isFinite(Number(metadata.fileSize)) ? Number(metadata.fileSize) : null,
    durationSeconds: Number.isFinite(Number(metadata.durationSeconds))
      ? Number(metadata.durationSeconds)
      : null,
    thumbnailUrl: normalizeString(metadata.thumbnailUrl)
  };
}

async function normalizeLessonAssetForPlayback(asset = {}) {
  const provider = normalizeProvider(asset.provider);
  const metadata = asset.metadata || {};
  const oneDriveMetadata = metadata.oneDrive || {};
  const storedOneDriveUrl = normalizeString(oneDriveMetadata.webUrl);
  const base = {
    id: asset._id?.toString ? asset._id.toString() : asset._id,
    provider: asset.provider,
    title: normalizeString(asset.title),
    description: normalizeString(asset.description),
    required: Boolean(asset.required),
    metadata: extractSafeMetadata(metadata)
  };

  if (provider === 'onedrive') {
    const stream = await generateOneDriveStreamingLink(metadata.oneDrive || {});
    const fallbackUrl = storedOneDriveUrl || null;
    return {
      ...base,
      playback: {
        type: 'onedrive',
        streamUrl: stream.streamUrl,
        url: fallbackUrl,
        expiresAt: stream.expiresAt,
        error: stream.streamUrl || fallbackUrl ? null : stream.error
      }
    };
  }

  if (provider === 'youtube') {
    const embed = buildYouTubeEmbedMetadata(metadata.youtube?.videoId, metadata);
    return {
      ...base,
      playback: embed
        ? {
            type: 'youtube',
            ...embed
          }
        : {
            type: 'youtube',
            embedUrl: null,
            videoId: null,
            thumbnailUrl: null,
            error: 'youtube_video_unavailable'
          }
    };
  }

  return {
    ...base,
    url: normalizeString(asset.url),
    playback: {
      type: 'direct',
      url: normalizeString(asset.url)
    }
  };
}

module.exports = {
  normalizeLessonAssetForPlayback,
  generateOneDriveStreamingLink,
  buildYouTubeEmbedMetadata
};
