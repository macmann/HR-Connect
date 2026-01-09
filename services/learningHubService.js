const COURSE_STATUSES = new Set(['draft', 'published', 'archived']);
const EXTERNAL_ASSET_PROVIDERS = new Set(['onedrive', 'youtube']);
const PROGRESS_TYPES = new Set(['lesson', 'module', 'course']);
const PROGRESS_STATUSES = new Set(['not_started', 'in_progress', 'completed']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProvider(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeBoolean(value) {
  return value === true || value === 'true';
}

function normalizePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const clamped = Math.max(0, Math.min(100, parsed));
  return Math.round(clamped * 100) / 100;
}

function normalizeProgressStatus(value) {
  const normalized = normalizeString(value).toLowerCase();
  return PROGRESS_STATUSES.has(normalized) ? normalized : '';
}

function normalizeCourseStatus(value) {
  const normalized = normalizeString(value).toLowerCase();
  return COURSE_STATUSES.has(normalized) ? normalized : '';
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

function buildAssetMetadata(payload = {}, { url, provider } = {}) {
  const oneDrive = payload.oneDrive && typeof payload.oneDrive === 'object'
    ? {
        driveId: normalizeString(payload.oneDrive.driveId),
        itemId: normalizeString(payload.oneDrive.itemId),
        shareId: normalizeString(payload.oneDrive.shareId),
        webUrl: normalizeString(payload.oneDrive.webUrl)
      }
    : null;
  const youtube = payload.youtube && typeof payload.youtube === 'object'
    ? {
        videoId: normalizeString(payload.youtube.videoId)
      }
    : null;
  const normalizedProvider = normalizeProvider(provider);
  const normalizedUrl = normalizeString(url);

  if (normalizedProvider === 'youtube' && normalizedUrl) {
    const videoId = parseYouTubeVideoId(normalizedUrl);
    if (videoId && (!youtube || !youtube.videoId)) {
      if (youtube) {
        youtube.videoId = videoId;
      } else {
        payload.youtube = { videoId };
      }
    }
  }

  if (normalizedProvider === 'onedrive' && normalizedUrl) {
    if (oneDrive) {
      if (!oneDrive.webUrl) {
        oneDrive.webUrl = normalizedUrl;
      }
    } else {
      payload.oneDrive = { webUrl: normalizedUrl };
    }
  }

  return {
    oneDrive: payload.oneDrive && typeof payload.oneDrive === 'object'
      ? {
          driveId: normalizeString(payload.oneDrive.driveId),
          itemId: normalizeString(payload.oneDrive.itemId),
          shareId: normalizeString(payload.oneDrive.shareId),
          webUrl: normalizeString(payload.oneDrive.webUrl)
        }
      : null,
    youtube: payload.youtube && typeof payload.youtube === 'object'
      ? {
          videoId: normalizeString(payload.youtube.videoId)
        }
      : null,
    mimeType: normalizeString(payload.mimeType),
    fileName: normalizeString(payload.fileName),
    fileSize: Number.isFinite(Number(payload.fileSize)) ? Number(payload.fileSize) : null,
    durationSeconds: Number.isFinite(Number(payload.durationSeconds))
      ? Number(payload.durationSeconds)
      : null,
    thumbnailUrl: normalizeString(payload.thumbnailUrl)
  };
}

function buildCourse(payload = {}, { userId } = {}) {
  const title = normalizeString(payload.title);
  if (!title) {
    return { error: 'title_required' };
  }

  const status = normalizeCourseStatus(payload.status) || 'draft';
  const now = new Date();
  const course = {
    title,
    summary: normalizeString(payload.summary),
    description: normalizeString(payload.description),
    status,
    createdAt: now,
    updatedAt: now,
    publishedAt: status === 'published' ? now : null,
    archivedAt: status === 'archived' ? now : null
  };

  if (userId) {
    course.createdBy = userId;
  }

  return { course };
}

function buildModule(payload = {}) {
  const title = normalizeString(payload.title);
  if (!title) {
    return { error: 'title_required' };
  }
  if (!payload.courseId) {
    return { error: 'course_id_required' };
  }

  const now = new Date();
  return {
    module: {
      courseId: String(payload.courseId),
      title,
      description: normalizeString(payload.description),
      order: Number.isFinite(Number(payload.order)) ? Number(payload.order) : 0,
      required: normalizeBoolean(payload.required),
      createdAt: now,
      updatedAt: now
    }
  };
}

function buildLesson(payload = {}) {
  const title = normalizeString(payload.title);
  if (!title) {
    return { error: 'title_required' };
  }
  if (!payload.moduleId) {
    return { error: 'module_id_required' };
  }

  const now = new Date();
  return {
    lesson: {
      moduleId: String(payload.moduleId),
      title,
      description: normalizeString(payload.description),
      order: Number.isFinite(Number(payload.order)) ? Number(payload.order) : 0,
      durationMinutes: Number.isFinite(Number(payload.durationMinutes))
        ? Number(payload.durationMinutes)
        : null,
      required: normalizeBoolean(payload.required),
      createdAt: now,
      updatedAt: now
    }
  };
}

function buildLessonAsset(payload = {}) {
  const lessonId = payload.lessonId;
  const provider = normalizeString(payload.provider);
  const normalizedProvider = normalizeProvider(provider);
  const url = normalizeString(payload.url);
  const isExternalProvider = EXTERNAL_ASSET_PROVIDERS.has(normalizedProvider);

  if (!lessonId) {
    return { error: 'lesson_id_required' };
  }
  if (!provider) {
    return { error: 'provider_required' };
  }
  if (!url && !isExternalProvider) {
    return { error: 'url_required' };
  }

  const now = new Date();
  return {
    asset: {
      lessonId: String(lessonId),
      provider,
      url: isExternalProvider ? null : url,
      title: normalizeString(payload.title),
      description: normalizeString(payload.description),
      required: normalizeBoolean(payload.required),
      metadata: buildAssetMetadata(payload, { url, provider }),
      createdAt: now,
      updatedAt: now
    }
  };
}

function buildCourseAssignments(payload = {}, { assignedBy } = {}) {
  const courseId = payload.courseId;
  if (!courseId) {
    return { error: 'course_id_required' };
  }

  const roles = Array.isArray(payload.roles)
    ? payload.roles.map(role => normalizeString(role)).filter(Boolean)
    : [];
  const employeeIds = Array.isArray(payload.employeeIds)
    ? payload.employeeIds.map(id => normalizeString(id)).filter(Boolean)
    : [];

  if (!roles.length && !employeeIds.length) {
    return { error: 'assignment_targets_required' };
  }

  const required = normalizeBoolean(payload.required);
  const dueDate = payload.dueDate ? new Date(payload.dueDate) : null;
  const now = new Date();

  const assignments = [
    ...roles.map(role => ({
      courseId: String(courseId),
      assignmentType: 'role',
      role,
      employeeId: null,
      required,
      dueDate,
      assignedAt: now,
      assignedBy: assignedBy || null
    })),
    ...employeeIds.map(employeeId => ({
      courseId: String(courseId),
      assignmentType: 'employee',
      role: null,
      employeeId,
      required,
      dueDate,
      assignedAt: now,
      assignedBy: assignedBy || null
    }))
  ];

  return { assignments };
}

function buildProgressEntry(payload = {}) {
  if (!payload.employeeId) {
    return { error: 'employee_id_required' };
  }
  if (!payload.courseId) {
    return { error: 'course_id_required' };
  }

  const progressType = normalizeString(payload.progressType) || 'course';
  if (!PROGRESS_TYPES.has(progressType)) {
    return { error: 'invalid_progress_type' };
  }

  const moduleId = normalizeString(payload.moduleId);
  const lessonId = normalizeString(payload.lessonId);
  if (progressType !== 'course' && !moduleId) {
    return { error: 'module_id_required' };
  }
  if (progressType === 'lesson' && !lessonId) {
    return { error: 'lesson_id_required' };
  }

  const statusInput = normalizeProgressStatus(payload.status);
  if (payload.status && !statusInput) {
    return { error: 'invalid_status' };
  }

  const completionPercent = normalizePercent(payload.completionPercent);
  if (Object.prototype.hasOwnProperty.call(payload, 'completionPercent')
    && completionPercent === null) {
    return { error: 'invalid_completion_percent' };
  }

  const videoWatchPercent = normalizePercent(payload.videoWatchPercent);
  if (Object.prototype.hasOwnProperty.call(payload, 'videoWatchPercent')
    && videoWatchPercent === null) {
    return { error: 'invalid_video_watch_percent' };
  }

  const completedFlag = normalizeBoolean(payload.completed);
  let status = statusInput;
  if (completedFlag || completionPercent === 100 || videoWatchPercent === 100) {
    status = 'completed';
  }
  if (!status) {
    if ((completionPercent && completionPercent > 0) || (videoWatchPercent && videoWatchPercent > 0)) {
      status = 'in_progress';
    } else {
      status = 'not_started';
    }
  }

  const now = new Date();
  const startedAt = payload.startedAt ? new Date(payload.startedAt) : null;
  const completedAt = payload.completedAt ? new Date(payload.completedAt) : null;
  const normalizedStartedAt = status === 'not_started' ? startedAt : startedAt || now;
  const normalizedCompletedAt = status === 'completed' ? completedAt || now : completedAt;

  return {
    progress: {
      employeeId: String(payload.employeeId),
      courseId: String(payload.courseId),
      moduleId: moduleId || null,
      lessonId: lessonId || null,
      progressType,
      status,
      completionPercent,
      videoWatchPercent,
      startedAt: normalizedStartedAt,
      completedAt: normalizedCompletedAt,
      updatedAt: now
    }
  };
}

function calculateRollupStatus({ totalCount, completedCount, hasStarted }) {
  if (totalCount === 0) {
    return 'completed';
  }
  if (completedCount >= totalCount) {
    return 'completed';
  }
  if (completedCount > 0 || hasStarted) {
    return 'in_progress';
  }
  return 'not_started';
}

function calculateCompletionPercent(totalCount, completedCount) {
  if (!totalCount) return 100;
  return Math.round((completedCount / totalCount) * 10000) / 100;
}

async function computeModuleRollup(database, { employeeId, moduleId, courseId }) {
  const lessons = await database
    .collection('learningLessons')
    .find({ moduleId: String(moduleId) })
    .toArray();
  const requiredLessons = lessons.filter(lesson => lesson.required);
  const lessonList = requiredLessons.length ? requiredLessons : lessons;
  const lessonIds = lessonList.map(lesson => lesson._id.toString());

  const lessonProgress = lessonIds.length
    ? await database.collection('learningProgress').find({
        employeeId: String(employeeId),
        progressType: 'lesson',
        lessonId: { $in: lessonIds }
      }).toArray()
    : [];

  const completedLessonIds = new Set(
    lessonProgress.filter(progress => progress.status === 'completed').map(progress => progress.lessonId)
  );

  const completedCount = lessonIds.filter(id => completedLessonIds.has(id)).length;
  const hasStarted = lessonProgress.some(progress => progress.status === 'in_progress');
  const status = calculateRollupStatus({
    totalCount: lessonIds.length,
    completedCount,
    hasStarted
  });
  const completionPercent = calculateCompletionPercent(lessonIds.length, completedCount);
  const startedAtValues = lessonProgress
    .map(progress => progress.startedAt)
    .filter(date => date instanceof Date && !Number.isNaN(date.valueOf()));
  const completedAtValues = lessonProgress
    .map(progress => progress.completedAt)
    .filter(date => date instanceof Date && !Number.isNaN(date.valueOf()));
  const startedAt = startedAtValues.length ? new Date(Math.min(...startedAtValues.map(date => date.valueOf()))) : null;
  const completedAt = status === 'completed' && completedAtValues.length
    ? new Date(Math.max(...completedAtValues.map(date => date.valueOf())))
    : null;

  const now = new Date();
  const progress = {
    employeeId: String(employeeId),
    courseId: String(courseId),
    moduleId: String(moduleId),
    lessonId: null,
    progressType: 'module',
    status,
    completionPercent,
    startedAt: status === 'not_started' ? startedAt : startedAt || now,
    completedAt: status === 'completed' ? completedAt || now : completedAt,
    updatedAt: now
  };

  await database.collection('learningProgress').updateOne(
    {
      employeeId: progress.employeeId,
      courseId: progress.courseId,
      moduleId: progress.moduleId,
      lessonId: null,
      progressType: 'module'
    },
    { $set: progress },
    { upsert: true }
  );

  return progress;
}

async function computeCourseRollup(database, { employeeId, courseId }) {
  const modules = await database
    .collection('learningModules')
    .find({ courseId: String(courseId) })
    .toArray();
  const requiredModules = modules.filter(module => module.required);
  const moduleList = requiredModules.length ? requiredModules : modules;
  const moduleIds = moduleList.map(module => module._id.toString());

  const moduleProgress = moduleIds.length
    ? await database.collection('learningProgress').find({
        employeeId: String(employeeId),
        progressType: 'module',
        moduleId: { $in: moduleIds }
      }).toArray()
    : [];

  const completedModuleIds = new Set(
    moduleProgress.filter(progress => progress.status === 'completed').map(progress => progress.moduleId)
  );
  const completedCount = moduleIds.filter(id => completedModuleIds.has(id)).length;
  const hasStarted = moduleProgress.some(progress => progress.status === 'in_progress');
  const status = calculateRollupStatus({
    totalCount: moduleIds.length,
    completedCount,
    hasStarted
  });
  const completionPercent = calculateCompletionPercent(moduleIds.length, completedCount);
  const startedAtValues = moduleProgress
    .map(progress => progress.startedAt)
    .filter(date => date instanceof Date && !Number.isNaN(date.valueOf()));
  const completedAtValues = moduleProgress
    .map(progress => progress.completedAt)
    .filter(date => date instanceof Date && !Number.isNaN(date.valueOf()));
  const startedAt = startedAtValues.length ? new Date(Math.min(...startedAtValues.map(date => date.valueOf()))) : null;
  const completedAt = status === 'completed' && completedAtValues.length
    ? new Date(Math.max(...completedAtValues.map(date => date.valueOf())))
    : null;

  const now = new Date();
  const progress = {
    employeeId: String(employeeId),
    courseId: String(courseId),
    moduleId: null,
    lessonId: null,
    progressType: 'course',
    status,
    completionPercent,
    startedAt: status === 'not_started' ? startedAt : startedAt || now,
    completedAt: status === 'completed' ? completedAt || now : completedAt,
    updatedAt: now
  };

  await database.collection('learningProgress').updateOne(
    {
      employeeId: progress.employeeId,
      courseId: progress.courseId,
      moduleId: null,
      lessonId: null,
      progressType: 'course'
    },
    { $set: progress },
    { upsert: true }
  );

  return progress;
}

function applyCourseUpdates(payload = {}) {
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
    const title = normalizeString(payload.title);
    if (!title) {
      return { error: 'title_required' };
    }
    updates.title = title;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'summary')) {
    updates.summary = normalizeString(payload.summary);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
    updates.description = normalizeString(payload.description);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
    const status = normalizeCourseStatus(payload.status);
    if (!status) {
      return { error: 'invalid_status' };
    }
    updates.status = status;
  }

  if (!Object.keys(updates).length) {
    return { error: 'no_fields_to_update' };
  }

  updates.updatedAt = new Date();
  return { updates };
}

function applyModuleUpdates(payload = {}) {
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
    const title = normalizeString(payload.title);
    if (!title) {
      return { error: 'title_required' };
    }
    updates.title = title;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
    updates.description = normalizeString(payload.description);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'order')) {
    updates.order = Number.isFinite(Number(payload.order)) ? Number(payload.order) : 0;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'required')) {
    updates.required = normalizeBoolean(payload.required);
  }

  if (!Object.keys(updates).length) {
    return { error: 'no_fields_to_update' };
  }

  updates.updatedAt = new Date();
  return { updates };
}

function applyLessonUpdates(payload = {}) {
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
    const title = normalizeString(payload.title);
    if (!title) {
      return { error: 'title_required' };
    }
    updates.title = title;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
    updates.description = normalizeString(payload.description);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'order')) {
    updates.order = Number.isFinite(Number(payload.order)) ? Number(payload.order) : 0;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'required')) {
    updates.required = normalizeBoolean(payload.required);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'durationMinutes')) {
    updates.durationMinutes = Number.isFinite(Number(payload.durationMinutes))
      ? Number(payload.durationMinutes)
      : null;
  }

  if (!Object.keys(updates).length) {
    return { error: 'no_fields_to_update' };
  }

  updates.updatedAt = new Date();
  return { updates };
}

function applyAssetUpdates(payload = {}) {
  const updates = {};
  const provider = Object.prototype.hasOwnProperty.call(payload, 'provider')
    ? normalizeString(payload.provider)
    : '';
  const normalizedProvider = normalizeProvider(provider);
  const isExternalProvider = EXTERNAL_ASSET_PROVIDERS.has(normalizedProvider);
  const url = Object.prototype.hasOwnProperty.call(payload, 'url')
    ? normalizeString(payload.url)
    : '';

  if (Object.prototype.hasOwnProperty.call(payload, 'provider')) {
    if (!provider) {
      return { error: 'provider_required' };
    }
    updates.provider = provider;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'url')) {
    if (!url && !isExternalProvider) {
      return { error: 'url_required' };
    }
    if (!isExternalProvider) {
      updates.url = url;
    } else if (!updates.provider) {
      updates.url = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
    updates.title = normalizeString(payload.title);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
    updates.description = normalizeString(payload.description);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'required')) {
    updates.required = normalizeBoolean(payload.required);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'oneDrive')
    || Object.prototype.hasOwnProperty.call(payload, 'youtube')
    || Object.prototype.hasOwnProperty.call(payload, 'mimeType')
    || Object.prototype.hasOwnProperty.call(payload, 'fileName')
    || Object.prototype.hasOwnProperty.call(payload, 'fileSize')
    || Object.prototype.hasOwnProperty.call(payload, 'durationSeconds')
    || Object.prototype.hasOwnProperty.call(payload, 'thumbnailUrl')
    || (isExternalProvider && Object.prototype.hasOwnProperty.call(payload, 'url'))) {
    updates.metadata = buildAssetMetadata(payload, { url, provider });
  }

  if (!Object.keys(updates).length) {
    return { error: 'no_fields_to_update' };
  }

  updates.updatedAt = new Date();
  return { updates };
}

module.exports = {
  normalizeCourseStatus,
  buildCourse,
  buildModule,
  buildLesson,
  buildLessonAsset,
  buildCourseAssignments,
  buildProgressEntry,
  computeModuleRollup,
  computeCourseRollup,
  applyCourseUpdates,
  applyModuleUpdates,
  applyLessonUpdates,
  applyAssetUpdates
};
