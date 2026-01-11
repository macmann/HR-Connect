const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase, db } = require('../db');
const {
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
} = require('../services/learningHubService');
const {
  buildRoleAssignment,
  applyRoleAssignmentUpdates,
  reconcileLearningRoleAssignments,
  scheduleLearningRoleAssignmentReconciliation
} = require('../services/learningRoleAssignmentService');
const {
  normalizeLessonAssetForPlayback
} = require('../services/learningAssetPlayback');

const router = express.Router();

const HR_LEARNING_ROLES = new Set([
  'hr',
  'human resources',
  'l&d',
  'ld',
  'lnd',
  'learning and development',
  'learning & development'
]);

const MANAGER_ROLES = new Set(['manager', 'superadmin']);
const REPORT_MANAGER_KEYWORDS = ['appraiser', 'manager', 'supervisor', 'reporting'];

function normalizeRole(role) {
  return typeof role === 'string' ? role.trim().toLowerCase() : '';
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getUserRoles(user) {
  if (!user) return [];
  if (Array.isArray(user.roles)) {
    return user.roles.map(normalizeRole).filter(Boolean);
  }
  const singleRole = normalizeRole(user.role);
  return singleRole ? [singleRole] : [];
}

function hasAnyRole(user, allowedRoles) {
  const roles = getUserRoles(user);
  return roles.some(role => allowedRoles.has(role));
}

function requireAuthenticatedUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'authentication_required' });
  }
  return next();
}

function getAuthenticatedEmployeeId(req, res) {
  const employeeId = String(req.user?.id || '');
  if (!employeeId) {
    res.status(400).json({ error: 'employee_id_required' });
    return null;
  }
  return employeeId;
}

function findValueByKeywords(source, keywords = []) {
  if (!source || typeof source !== 'object') return '';
  const normalizedKeywords = keywords.map(keyword => normalizeString(keyword).toLowerCase());
  return Object.entries(source).reduce((match, [key, value]) => {
    if (match) return match;
    const normalizedKey = normalizeString(key).toLowerCase();
    if (!normalizedKey) return match;
    if (normalizedKeywords.some(keyword => normalizedKey.includes(keyword))) {
      if (value !== undefined && value !== null && value !== '') {
        return typeof value === 'string' ? value : String(value);
      }
    }
    return match;
  }, '');
}

function normalizeIdentifier(value) {
  return normalizeString(value).toLowerCase();
}

function parseManagerCandidates(rawValue) {
  if (!rawValue) return [];
  return rawValue
    .split(/[\\/,&]+/)
    .map(entry => normalizeIdentifier(entry))
    .filter(Boolean);
}

function getEmployeeManagerValue(employee) {
  return findValueByKeywords(employee, REPORT_MANAGER_KEYWORDS);
}

function getEmployeeEmail(employee) {
  return findValueByKeywords(employee, ['email']);
}

function getEmployeeRole(employee) {
  const roleKey = Object.keys(employee || {}).find(key =>
    normalizeString(key).toLowerCase().includes('role')
  );
  return roleKey ? normalizeString(employee[roleKey]) : '';
}

function employeeReportsTo(employee, managerIdentifiers) {
  if (!managerIdentifiers || !managerIdentifiers.size) return false;
  const managerValue = getEmployeeManagerValue(employee);
  if (!managerValue) return false;
  const candidates = parseManagerCandidates(managerValue);
  return candidates.some(candidate => managerIdentifiers.has(candidate));
}

function requireLearningHubWriteAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'authentication_required' });
  }
  if (!hasAnyRole(req.user, HR_LEARNING_ROLES)) {
    return res.status(403).json({ error: 'learning_hub_write_forbidden' });
  }
  return next();
}

function requireProgressReadAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'authentication_required' });
  }
  const hasManagerRole = hasAnyRole(req.user, MANAGER_ROLES);
  const hasLearningRole = hasAnyRole(req.user, HR_LEARNING_ROLES);
  if (!hasManagerRole && !hasLearningRole) {
    return res.status(403).json({ error: 'learning_hub_progress_forbidden' });
  }
  return next();
}

function hasProgressOverrideAccess(user) {
  return hasAnyRole(user, HR_LEARNING_ROLES) || hasAnyRole(user, MANAGER_ROLES);
}

function resolveProgressEmployeeId(req, res) {
  const requestedEmployeeId = req.body.employeeId ? String(req.body.employeeId) : '';
  const employeeId = requestedEmployeeId || String(req.user?.id || '');

  if (!employeeId) {
    res.status(400).json({ error: 'employee_id_required' });
    return null;
  }

  if (requestedEmployeeId && employeeId !== String(req.user?.id || '')) {
    if (!hasProgressOverrideAccess(req.user)) {
      res.status(403).json({ error: 'learning_hub_progress_forbidden' });
      return null;
    }
  }

  return employeeId;
}

async function resolveReportEmployeeScope(database, user) {
  if (hasAnyRole(user, HR_LEARNING_ROLES)) {
    const employees = await database.collection('employees').find().toArray();
    return { employeeIds: null, employees };
  }

  if (!hasAnyRole(user, MANAGER_ROLES)) {
    return { employeeIds: new Set(), employees: [] };
  }

  const employees = await database.collection('employees').find().toArray();
  const managerId = user?.employeeId ? String(user.employeeId) : '';
  const managerRecord = managerId
    ? employees.find(emp => String(emp?.id) === managerId)
    : null;

  const managerIdentifiers = new Set();
  if (managerRecord?.name) {
    managerIdentifiers.add(normalizeIdentifier(managerRecord.name));
  }
  if (managerRecord?.id !== undefined && managerRecord?.id !== null) {
    managerIdentifiers.add(normalizeIdentifier(String(managerRecord.id)));
  }
  if (user?.email) {
    managerIdentifiers.add(normalizeIdentifier(user.email));
  }
  const managerEmail = managerRecord ? getEmployeeEmail(managerRecord) : '';
  if (managerEmail) {
    managerIdentifiers.add(normalizeIdentifier(managerEmail));
  }

  const team = employees.filter(employee => employeeReportsTo(employee, managerIdentifiers));
  const employeeIds = new Set(team.map(employee => String(employee.id)));
  return { employeeIds, employees: team };
}

function buildProgressKey(employeeId, courseId) {
  return `${String(employeeId)}:${String(courseId)}`;
}

function applyProgressTimestamps(existingProgress, progress) {
  if (!existingProgress) return progress;

  const existingStartedAt = existingProgress.startedAt instanceof Date
    ? existingProgress.startedAt
    : null;
  if (existingStartedAt && (!progress.startedAt || existingStartedAt < progress.startedAt)) {
    progress.startedAt = existingStartedAt;
  }

  const existingCompletedAt = existingProgress.completedAt instanceof Date
    ? existingProgress.completedAt
    : null;
  if (progress.status === 'completed') {
    if (existingCompletedAt && (!progress.completedAt || existingCompletedAt < progress.completedAt)) {
      progress.completedAt = existingCompletedAt;
    }
  } else {
    progress.completedAt = null;
  }

  return progress;
}

async function upsertLearningProgress(database, progress) {
  const query = {
    employeeId: progress.employeeId,
    courseId: progress.courseId,
    moduleId: progress.moduleId || null,
    lessonId: progress.lessonId || null,
    progressType: progress.progressType
  };

  const existingProgress = await database.collection('learningProgress').findOne(query);
  const mergedProgress = applyProgressTimestamps(existingProgress, { ...progress });

  await database.collection('learningProgress').updateOne(
    query,
    { $set: mergedProgress },
    { upsert: true }
  );

  return mergedProgress;
}

function selectUniqueAssignments(assignments = []) {
  const assignmentsByKey = new Map();
  assignments.forEach(assignment => {
    if (!assignment?.employeeId || !assignment?.courseId) return;
    const key = buildProgressKey(assignment.employeeId, assignment.courseId);
    const existing = assignmentsByKey.get(key);
    if (!existing) {
      assignmentsByKey.set(key, assignment);
      return;
    }
    if (existing.assignmentType !== 'employee' && assignment.assignmentType === 'employee') {
      assignmentsByKey.set(key, assignment);
    }
  });
  return Array.from(assignmentsByKey.values());
}

async function buildCompletionByRoleReport(database, { employeeIds, employees }) {
  const assignmentQuery = {
    assignmentType: { $in: ['employee', 'role_auto'] },
    employeeId: { $ne: null }
  };
  if (employeeIds) {
    assignmentQuery.employeeId = { $in: Array.from(employeeIds) };
  }

  const [assignments, progress] = await Promise.all([
    database.collection('learningCourseAssignments').find(assignmentQuery).toArray(),
    database.collection('learningProgress').find({ progressType: 'course' }).toArray()
  ]);

  const employeeRoles = new Map();
  (employees || []).forEach(employee => {
    const role = normalizeString(getEmployeeRole(employee)).toLowerCase();
    if (!role) return;
    employeeRoles.set(String(employee.id), role);
  });

  const progressByKey = new Map();
  progress.forEach(entry => {
    if (!entry?.employeeId || !entry?.courseId) return;
    progressByKey.set(buildProgressKey(entry.employeeId, entry.courseId), entry);
  });

  const roleTotals = new Map();
  selectUniqueAssignments(assignments).forEach(assignment => {
    const employeeRole = employeeRoles.get(String(assignment.employeeId));
    if (!employeeRole) return;
    const key = buildProgressKey(assignment.employeeId, assignment.courseId);
    const progressEntry = progressByKey.get(key);
    const status = progressEntry?.status || 'not_started';
    const current = roleTotals.get(employeeRole) || {
      role: employeeRole,
      totalAssignments: 0,
      completed: 0,
      inProgress: 0,
      notStarted: 0
    };
    current.totalAssignments += 1;
    if (status === 'completed') {
      current.completed += 1;
    } else if (status === 'in_progress') {
      current.inProgress += 1;
    } else {
      current.notStarted += 1;
    }
    roleTotals.set(employeeRole, current);
  });

  const roles = Array.from(roleTotals.values()).map(entry => {
    const completionRate = entry.totalAssignments
      ? Math.round((entry.completed / entry.totalAssignments) * 10000) / 100
      : 0;
    return { ...entry, completionRate };
  });

  return { roles };
}

async function buildOverdueMandatoryReport(database, { employeeIds }) {
  const assignmentQuery = {
    required: true,
    dueDate: { $ne: null }
  };
  if (employeeIds) {
    assignmentQuery.employeeId = { $in: Array.from(employeeIds) };
  } else {
    assignmentQuery.employeeId = { $ne: null };
  }

  const [assignments, progress, courses] = await Promise.all([
    database.collection('learningCourseAssignments').find(assignmentQuery).toArray(),
    database.collection('learningProgress').find({ progressType: 'course' }).toArray(),
    database.collection('learningCourses').find().toArray()
  ]);

  const progressByKey = new Map();
  progress.forEach(entry => {
    if (!entry?.employeeId || !entry?.courseId) return;
    progressByKey.set(buildProgressKey(entry.employeeId, entry.courseId), entry);
  });

  const courseById = new Map(
    courses.map(course => [String(course._id), course])
  );

  const now = new Date();
  const overdueAssignments = selectUniqueAssignments(assignments).filter(assignment => {
    if (!assignment?.dueDate) return false;
    const dueDate = assignment.dueDate instanceof Date
      ? assignment.dueDate
      : new Date(assignment.dueDate);
    if (Number.isNaN(dueDate.getTime())) return false;
    if (dueDate >= now) return false;
    const key = buildProgressKey(assignment.employeeId, assignment.courseId);
    const status = progressByKey.get(key)?.status || 'not_started';
    return status !== 'completed';
  });

  const overdueByCourse = new Map();
  const overdue = overdueAssignments.map(assignment => {
    const key = buildProgressKey(assignment.employeeId, assignment.courseId);
    const course = courseById.get(String(assignment.courseId)) || null;
    const status = progressByKey.get(key)?.status || 'not_started';
    const entry = {
      employeeId: assignment.employeeId,
      courseId: assignment.courseId,
      courseTitle: course?.title || null,
      dueDate: assignment.dueDate,
      status
    };
    const summary = overdueByCourse.get(assignment.courseId) || {
      courseId: assignment.courseId,
      courseTitle: course?.title || null,
      overdueCount: 0
    };
    summary.overdueCount += 1;
    overdueByCourse.set(assignment.courseId, summary);
    return entry;
  });

  return {
    overdueCount: overdue.length,
    byCourse: Array.from(overdueByCourse.values()),
    overdue
  };
}

async function buildTeamProgressReport(database, { employeeIds, employees }) {
  const assignmentQuery = {};
  if (employeeIds) {
    assignmentQuery.employeeId = { $in: Array.from(employeeIds) };
  } else {
    assignmentQuery.employeeId = { $ne: null };
  }

  const [assignments, progress, courses] = await Promise.all([
    database.collection('learningCourseAssignments').find(assignmentQuery).toArray(),
    database.collection('learningProgress').find({ progressType: 'course' }).toArray(),
    database.collection('learningCourses').find().toArray()
  ]);

  const progressByKey = new Map();
  progress.forEach(entry => {
    if (!entry?.employeeId || !entry?.courseId) return;
    progressByKey.set(buildProgressKey(entry.employeeId, entry.courseId), entry);
  });

  const courseById = new Map(
    courses.map(course => [String(course._id), course])
  );

  const uniqueAssignments = selectUniqueAssignments(assignments);
  const summaries = new Map();

  uniqueAssignments.forEach(assignment => {
    const employeeId = String(assignment.employeeId);
    if (employeeIds && !employeeIds.has(employeeId)) return;
    const key = buildProgressKey(employeeId, assignment.courseId);
    const status = progressByKey.get(key)?.status || 'not_started';
    const summary = summaries.get(employeeId) || {
      employeeId,
      employeeName: null,
      role: null,
      totalAssignments: 0,
      completed: 0,
      inProgress: 0,
      notStarted: 0,
      courses: []
    };
    summary.totalAssignments += 1;
    if (status === 'completed') {
      summary.completed += 1;
    } else if (status === 'in_progress') {
      summary.inProgress += 1;
    } else {
      summary.notStarted += 1;
    }
    const course = courseById.get(String(assignment.courseId)) || null;
    summary.courses.push({
      courseId: assignment.courseId,
      courseTitle: course?.title || null,
      status
    });
    summaries.set(employeeId, summary);
  });

  if (employees && employees.length) {
    employees.forEach(employee => {
      const employeeId = String(employee.id);
      const summary = summaries.get(employeeId);
      if (!summary) return;
      summary.employeeName = employee?.name || null;
      summary.role = getEmployeeRole(employee) || null;
    });
  }

  const team = Array.from(summaries.values()).map(entry => {
    const completionRate = entry.totalAssignments
      ? Math.round((entry.completed / entry.totalAssignments) * 10000) / 100
      : 0;
    return { ...entry, completionRate };
  });

  return { team };
}

// Access policy:
// - All endpoints require authenticated portal sessions.
// - Write endpoints (course/module/lesson/asset create/edit/publish/archive/reorder/assignments)
//   require HR/L&D roles.
// - Progress read endpoints allow HR/L&D and manager roles.
router.use(requireAuthenticatedUser);

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch (error) {
    return null;
  }
}

async function resolveLessonHierarchy(database, lessonId) {
  const lessonObjectId = toObjectId(lessonId);
  if (!lessonObjectId) {
    return { error: 'invalid_lesson_id', status: 400 };
  }
  const lesson = await database.collection('learningLessons').findOne({ _id: lessonObjectId });
  if (!lesson) {
    return { error: 'lesson_not_found', status: 404 };
  }
  const moduleObjectId = toObjectId(lesson.moduleId);
  if (!moduleObjectId) {
    return { error: 'invalid_module_id', status: 400 };
  }
  const moduleDoc = await database.collection('learningModules').findOne({ _id: moduleObjectId });
  if (!moduleDoc) {
    return { error: 'module_not_found', status: 404 };
  }
  const courseObjectId = toObjectId(moduleDoc.courseId);
  if (!courseObjectId) {
    return { error: 'invalid_course_id', status: 400 };
  }
  const courseDoc = await database.collection('learningCourses').findOne({ _id: courseObjectId });
  if (!courseDoc) {
    return { error: 'course_not_found', status: 404 };
  }
  return { lesson, moduleDoc, courseDoc };
}

async function resolveModuleHierarchy(database, moduleId) {
  const moduleObjectId = toObjectId(moduleId);
  if (!moduleObjectId) {
    return { error: 'invalid_module_id', status: 400 };
  }
  const moduleDoc = await database.collection('learningModules').findOne({ _id: moduleObjectId });
  if (!moduleDoc) {
    return { error: 'module_not_found', status: 404 };
  }
  const courseObjectId = toObjectId(moduleDoc.courseId);
  if (!courseObjectId) {
    return { error: 'invalid_course_id', status: 400 };
  }
  const courseDoc = await database.collection('learningCourses').findOne({ _id: courseObjectId });
  if (!courseDoc) {
    return { error: 'course_not_found', status: 404 };
  }
  return { moduleDoc, courseDoc };
}

function normalizeDocument(document) {
  if (!document) return document;
  if (!document._id) return document;
  return { ...document, _id: document._id.toString() };
}

router.post('/courses', requireLearningHubWriteAccess, async (req, res) => {
  try {
    const { course, error } = buildCourse(req.body, { userId: req.user?.id });
    if (error) {
      return res.status(400).json({ error });
    }

    const database = getDatabase();
    const result = await database.collection('learningCourses').insertOne(course);
    db.invalidateCache?.();
    return res.status(201).json({ id: result.insertedId });
  } catch (error) {
    console.error('Failed to create course', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/role-assignments', requireLearningHubWriteAccess, async (req, res) => {
  try {
    const database = getDatabase();
    const filters = {};
    if (typeof req.query.role === 'string' && req.query.role.trim()) {
      filters.role = req.query.role.trim().toLowerCase();
    }
    if (typeof req.query.courseId === 'string' && req.query.courseId.trim()) {
      filters.courseId = req.query.courseId.trim();
    }
    const roleAssignments = await database
      .collection('learningRoleAssignments')
      .find(filters)
      .sort({ updatedAt: -1 })
      .toArray();
    return res.json({
      roleAssignments: roleAssignments.map(normalizeDocument)
    });
  } catch (error) {
    console.error('Failed to load role assignments', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/role-assignments', requireLearningHubWriteAccess, async (req, res) => {
  const { roleAssignment, error } = buildRoleAssignment(req.body, {
    userId: req.user?.id
  });
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const database = getDatabase();
    const result = await database.collection('learningRoleAssignments').findOneAndUpdate(
      { role: roleAssignment.role, courseId: roleAssignment.courseId },
      {
        $set: {
          courseId: roleAssignment.courseId,
          role: roleAssignment.role,
          required: roleAssignment.required,
          dueDays: roleAssignment.dueDays,
          updatedAt: roleAssignment.updatedAt,
          updatedBy: roleAssignment.updatedBy
        },
        $setOnInsert: {
          createdAt: roleAssignment.createdAt,
          createdBy: roleAssignment.createdBy
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
    db.invalidateCache?.();
    const assignmentId = result?.value?._id;
    const updatedExisting = result?.lastErrorObject?.updatedExisting;
    const status = updatedExisting ? 200 : 201;
    scheduleLearningRoleAssignmentReconciliation({ fullReconcile: true });
    return res.status(status).json({ id: assignmentId });
  } catch (error) {
    console.error('Failed to create role assignment', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/role-assignments/:id', requireLearningHubWriteAccess, async (req, res) => {
  const assignmentId = toObjectId(req.params.id);
  if (!assignmentId) {
    return res.status(400).json({ error: 'invalid_role_assignment_id' });
  }

  const { updates, error } = applyRoleAssignmentUpdates(req.body, {
    userId: req.user?.id
  });
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const database = getDatabase();
    if (updates.role || updates.courseId) {
      const current = await database.collection('learningRoleAssignments').findOne({ _id: assignmentId });
      if (!current) {
        return res.status(404).json({ error: 'role_assignment_not_found' });
      }
      const role = updates.role || current.role;
      const courseId = updates.courseId || current.courseId;
      const duplicate = await database.collection('learningRoleAssignments').findOne({
        _id: { $ne: assignmentId },
        role,
        courseId
      });
      if (duplicate) {
        return res.status(409).json({ error: 'role_assignment_duplicate' });
      }
    }

    const result = await database
      .collection('learningRoleAssignments')
      .updateOne({ _id: assignmentId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'role_assignment_not_found' });
    }

    db.invalidateCache?.();
    scheduleLearningRoleAssignmentReconciliation({ fullReconcile: true });
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update role assignment', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.delete('/role-assignments/:id', requireLearningHubWriteAccess, async (req, res) => {
  const assignmentId = toObjectId(req.params.id);
  if (!assignmentId) {
    return res.status(400).json({ error: 'invalid_role_assignment_id' });
  }

  try {
    const database = getDatabase();
    const result = await database
      .collection('learningRoleAssignments')
      .deleteOne({ _id: assignmentId });

    if (!result.deletedCount) {
      return res.status(404).json({ error: 'role_assignment_not_found' });
    }

    db.invalidateCache?.();
    scheduleLearningRoleAssignmentReconciliation({ fullReconcile: true });
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete role assignment', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/role-assignments/reconcile', requireLearningHubWriteAccess, async (_req, res) => {
  try {
    const result = await reconcileLearningRoleAssignments();
    return res.json(result);
  } catch (error) {
    console.error('Failed to reconcile role assignments', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/courses/:id', requireLearningHubWriteAccess, async (req, res) => {
  const courseId = toObjectId(req.params.id);
  if (!courseId) {
    return res.status(400).json({ error: 'invalid_course_id' });
  }

  const { updates, error } = applyCourseUpdates(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  if (updates.status === 'published') {
    updates.publishedAt = updates.publishedAt || new Date();
    updates.archivedAt = null;
  }
  if (updates.status === 'archived') {
    updates.archivedAt = updates.archivedAt || new Date();
  }
  if (updates.status === 'draft') {
    updates.publishedAt = null;
    updates.archivedAt = null;
  }

  try {
    const database = getDatabase();
    const result = await database
      .collection('learningCourses')
      .updateOne({ _id: courseId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'course_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update course', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/courses/:id/publish', requireLearningHubWriteAccess, async (req, res) => {
  const courseId = toObjectId(req.params.id);
  if (!courseId) {
    return res.status(400).json({ error: 'invalid_course_id' });
  }

  try {
    const database = getDatabase();
    const updates = {
      status: 'published',
      publishedAt: new Date(),
      archivedAt: null,
      updatedAt: new Date()
    };
    const result = await database
      .collection('learningCourses')
      .updateOne({ _id: courseId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'course_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to publish course', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/courses/:id/archive', requireLearningHubWriteAccess, async (req, res) => {
  const courseId = toObjectId(req.params.id);
  if (!courseId) {
    return res.status(400).json({ error: 'invalid_course_id' });
  }

  try {
    const database = getDatabase();
    const updates = {
      status: 'archived',
      archivedAt: new Date(),
      updatedAt: new Date()
    };
    const result = await database
      .collection('learningCourses')
      .updateOne({ _id: courseId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'course_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to archive course', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/courses/:courseId/modules', requireLearningHubWriteAccess, async (req, res) => {
  try {
    const { module, error } = buildModule({
      ...req.body,
      courseId: req.params.courseId
    });
    if (error) {
      return res.status(400).json({ error });
    }

    const database = getDatabase();
    const result = await database.collection('learningModules').insertOne(module);
    db.invalidateCache?.();
    return res.status(201).json({ id: result.insertedId });
  } catch (error) {
    console.error('Failed to create module', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/modules/:id', requireLearningHubWriteAccess, async (req, res) => {
  const moduleId = toObjectId(req.params.id);
  if (!moduleId) {
    return res.status(400).json({ error: 'invalid_module_id' });
  }

  const { updates, error } = applyModuleUpdates(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const database = getDatabase();
    const result = await database
      .collection('learningModules')
      .updateOne({ _id: moduleId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'module_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update module', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/modules/:moduleId/lessons', requireLearningHubWriteAccess, async (req, res) => {
  try {
    const { lesson, error } = buildLesson({
      ...req.body,
      moduleId: req.params.moduleId
    });
    if (error) {
      return res.status(400).json({ error });
    }

    const database = getDatabase();
    const result = await database.collection('learningLessons').insertOne(lesson);
    db.invalidateCache?.();
    return res.status(201).json({ id: result.insertedId });
  } catch (error) {
    console.error('Failed to create lesson', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/lessons/:id', requireLearningHubWriteAccess, async (req, res) => {
  const lessonId = toObjectId(req.params.id);
  if (!lessonId) {
    return res.status(400).json({ error: 'invalid_lesson_id' });
  }

  const { updates, error } = applyLessonUpdates(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const database = getDatabase();
    const result = await database
      .collection('learningLessons')
      .updateOne({ _id: lessonId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'lesson_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update lesson', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/lessons/:lessonId/assets', requireLearningHubWriteAccess, async (req, res) => {
  try {
    const { asset, error } = buildLessonAsset({
      ...req.body,
      lessonId: req.params.lessonId
    });
    if (error) {
      return res.status(400).json({ error });
    }

    const database = getDatabase();
    const result = await database.collection('learningLessonAssets').insertOne(asset);
    db.invalidateCache?.();
    return res.status(201).json({ id: result.insertedId });
  } catch (error) {
    console.error('Failed to create lesson asset', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/assets/:id', requireLearningHubWriteAccess, async (req, res) => {
  const assetId = toObjectId(req.params.id);
  if (!assetId) {
    return res.status(400).json({ error: 'invalid_asset_id' });
  }

  const { updates, error } = applyAssetUpdates(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const database = getDatabase();
    const result = await database
      .collection('learningLessonAssets')
      .updateOne({ _id: assetId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'asset_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update lesson asset', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/courses/:courseId/modules/reorder', requireLearningHubWriteAccess, async (req, res) => {
  const orderedModuleIds = Array.isArray(req.body.orderedModuleIds)
    ? req.body.orderedModuleIds
    : [];

  if (!orderedModuleIds.length) {
    return res.status(400).json({ error: 'ordered_module_ids_required' });
  }

  const orderMap = new Map();
  orderedModuleIds.forEach((id, index) => {
    const objectId = toObjectId(id);
    if (objectId) {
      orderMap.set(objectId.toString(), index);
    }
  });

  if (!orderMap.size) {
    return res.status(400).json({ error: 'invalid_module_ids' });
  }

  try {
    const database = getDatabase();
    const modules = await database
      .collection('learningModules')
      .find({
        _id: { $in: Array.from(orderMap.keys()).map(id => new ObjectId(id)) },
        courseId: String(req.params.courseId)
      })
      .toArray();

    if (modules.length !== orderMap.size) {
      return res.status(400).json({ error: 'module_course_mismatch' });
    }

    const bulkOps = modules.map(module => ({
      updateOne: {
        filter: { _id: module._id },
        update: { $set: { order: orderMap.get(module._id.toString()), updatedAt: new Date() } }
      }
    }));

    await database.collection('learningModules').bulkWrite(bulkOps, { ordered: true });
    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to reorder modules', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post(
  '/modules/:moduleId/lessons/reorder',
  requireLearningHubWriteAccess,
  async (req, res) => {
    const orderedLessonIds = Array.isArray(req.body.orderedLessonIds)
      ? req.body.orderedLessonIds
      : [];

    if (!orderedLessonIds.length) {
      return res.status(400).json({ error: 'ordered_lesson_ids_required' });
    }

    const orderMap = new Map();
    orderedLessonIds.forEach((id, index) => {
      const objectId = toObjectId(id);
      if (objectId) {
        orderMap.set(objectId.toString(), index);
      }
    });

    if (!orderMap.size) {
      return res.status(400).json({ error: 'invalid_lesson_ids' });
    }

    try {
      const database = getDatabase();
      const lessons = await database
        .collection('learningLessons')
        .find({
          _id: { $in: Array.from(orderMap.keys()).map(id => new ObjectId(id)) },
          moduleId: String(req.params.moduleId)
        })
        .toArray();

      if (lessons.length !== orderMap.size) {
        return res.status(400).json({ error: 'lesson_module_mismatch' });
      }

      const bulkOps = lessons.map(lesson => ({
        updateOne: {
          filter: { _id: lesson._id },
          update: { $set: { order: orderMap.get(lesson._id.toString()), updatedAt: new Date() } }
        }
      }));

      await database.collection('learningLessons').bulkWrite(bulkOps, { ordered: true });
      db.invalidateCache?.();
      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to reorder lessons', error);
      return res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/assignments', requireLearningHubWriteAccess, async (req, res) => {
  const { roleAssignments, employeeAssignments, error } = buildCourseAssignments(req.body, {
    assignedBy: req.user?.id
  });
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const database = getDatabase();
    const employeeBulkOps = [];
    const roleBulkOps = [];

    if (employeeAssignments.length) {
      employeeBulkOps.push(
        ...employeeAssignments.map(assignment => {
          const { assignedAt, assignedBy, ...updates } = assignment;
          return {
            updateOne: {
              filter: {
                courseId: assignment.courseId,
                assignmentType: assignment.assignmentType,
                role: assignment.role,
                employeeId: assignment.employeeId
              },
              update: {
                $set: updates,
                $setOnInsert: { assignedAt, assignedBy }
              },
              upsert: true
            }
          };
        })
      );
    }

    if (roleAssignments.length) {
      roleBulkOps.push(
        ...roleAssignments.map(roleAssignment => ({
          updateOne: {
            filter: {
              courseId: roleAssignment.courseId,
              role: roleAssignment.role
            },
            update: {
              $set: {
                courseId: roleAssignment.courseId,
                role: roleAssignment.role,
                required: roleAssignment.required,
                dueDays: roleAssignment.dueDays,
                updatedAt: roleAssignment.updatedAt,
                updatedBy: roleAssignment.updatedBy
              },
              $setOnInsert: {
                createdAt: roleAssignment.createdAt,
                createdBy: roleAssignment.createdBy
              }
            },
            upsert: true
          }
        }))
      );
    }

    if (employeeBulkOps.length) {
      await database.collection('learningCourseAssignments').bulkWrite(employeeBulkOps, { ordered: true });
    }

    if (roleBulkOps.length) {
      await database.collection('learningRoleAssignments').bulkWrite(roleBulkOps, { ordered: true });
      scheduleLearningRoleAssignmentReconciliation({ fullReconcile: true });
    }

    db.invalidateCache?.();
    return res.status(201).json({ count: roleAssignments.length + employeeAssignments.length });
  } catch (error) {
    console.error('Failed to assign course', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/lessons/:lessonId/playback', async (req, res) => {
  const lessonId = toObjectId(req.params.lessonId);
  if (!lessonId) {
    return res.status(400).json({ error: 'invalid_lesson_id' });
  }

  try {
    const database = getDatabase();
    const lesson = await database
      .collection('learningLessons')
      .findOne({ _id: lessonId });

    if (!lesson) {
      return res.status(404).json({ error: 'lesson_not_found' });
    }

    const assets = await database
      .collection('learningLessonAssets')
      .find({ lessonId: lessonId.toString() })
      .toArray();

    const normalizedAssets = await Promise.all(
      assets.map(asset => normalizeLessonAssetForPlayback(asset))
    );

    return res.json({
      lesson: normalizeDocument(lesson),
      assets: normalizedAssets
    });
  } catch (error) {
    console.error('Failed to load lesson playback', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/progress', async (req, res) => {
  try {
    const employeeId = resolveProgressEmployeeId(req, res);
    if (!employeeId) return;

    const progressType = typeof req.body.progressType === 'string'
      ? req.body.progressType.trim().toLowerCase()
      : 'lesson';
    let courseId = req.body.courseId ? String(req.body.courseId) : '';
    let moduleId = req.body.moduleId ? String(req.body.moduleId) : '';
    let lessonId = req.body.lessonId ? String(req.body.lessonId) : '';

    const database = getDatabase();

    if (progressType === 'lesson' || lessonId) {
      if (!lessonId) {
        return res.status(400).json({ error: 'lesson_id_required' });
      }
      const lessonObjectId = toObjectId(lessonId);
      if (!lessonObjectId) {
        return res.status(400).json({ error: 'invalid_lesson_id' });
      }
      const lesson = await database.collection('learningLessons').findOne({ _id: lessonObjectId });
      if (!lesson) {
        return res.status(404).json({ error: 'lesson_not_found' });
      }
      if (moduleId && moduleId !== lesson.moduleId) {
        return res.status(400).json({ error: 'lesson_module_mismatch' });
      }
      moduleId = lesson.moduleId;
    }

    if (progressType === 'lesson' || progressType === 'module') {
      if (!moduleId) {
        return res.status(400).json({ error: 'module_id_required' });
      }
      const moduleObjectId = toObjectId(moduleId);
      if (!moduleObjectId) {
        return res.status(400).json({ error: 'invalid_module_id' });
      }
      const moduleDoc = await database.collection('learningModules').findOne({ _id: moduleObjectId });
      if (!moduleDoc) {
        return res.status(404).json({ error: 'module_not_found' });
      }
      if (courseId && courseId !== moduleDoc.courseId) {
        return res.status(400).json({ error: 'module_course_mismatch' });
      }
      courseId = moduleDoc.courseId;
    }

    if (progressType === 'course') {
      if (!courseId) {
        return res.status(400).json({ error: 'course_id_required' });
      }
      const courseObjectId = toObjectId(courseId);
      if (!courseObjectId) {
        return res.status(400).json({ error: 'invalid_course_id' });
      }
      const courseDoc = await database.collection('learningCourses').findOne({ _id: courseObjectId });
      if (!courseDoc) {
        return res.status(404).json({ error: 'course_not_found' });
      }
      moduleId = '';
      lessonId = '';
    }

    if (progressType === 'module') {
      lessonId = '';
    }

    const { progress, error } = buildProgressEntry({
      ...req.body,
      progressType,
      employeeId,
      courseId,
      moduleId,
      lessonId
    });

    if (error) {
      return res.status(400).json({ error });
    }

    const savedProgress = await upsertLearningProgress(database, progress);

    if (savedProgress.progressType === 'lesson') {
      const moduleRollup = await computeModuleRollup(database, {
        employeeId,
        moduleId: savedProgress.moduleId,
        courseId: savedProgress.courseId
      });
      const courseRollup = await computeCourseRollup(database, {
        employeeId,
        courseId: savedProgress.courseId
      });
      return res.json({
        progress: savedProgress,
        moduleRollup,
        courseRollup
      });
    }

    if (savedProgress.progressType === 'module') {
      const courseRollup = await computeCourseRollup(database, {
        employeeId,
        courseId: savedProgress.courseId
      });
      return res.json({
        progress: savedProgress,
        courseRollup
      });
    }

    return res.json({ progress: savedProgress });
  } catch (error) {
    console.error('Failed to record progress', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/progress/lessons/:lessonId', async (req, res) => {
  try {
    const employeeId = resolveProgressEmployeeId(req, res);
    if (!employeeId) return;

    const lessonId = req.params.lessonId ? String(req.params.lessonId) : '';
    if (!lessonId) {
      return res.status(400).json({ error: 'lesson_id_required' });
    }

    const database = getDatabase();
    const { lesson, moduleDoc, courseDoc, error, status } = await resolveLessonHierarchy(
      database,
      lessonId
    );
    if (error) {
      return res.status(status).json({ error });
    }

    const { progress, error: progressError } = buildProgressEntry({
      ...req.body,
      progressType: 'lesson',
      employeeId,
      courseId: courseDoc._id.toString(),
      moduleId: moduleDoc._id.toString(),
      lessonId: lesson._id.toString()
    });

    if (progressError) {
      return res.status(400).json({ error: progressError });
    }

    const savedProgress = await upsertLearningProgress(database, progress);

    const moduleRollup = await computeModuleRollup(database, {
      employeeId,
      moduleId: savedProgress.moduleId,
      courseId: savedProgress.courseId
    });
    const courseRollup = await computeCourseRollup(database, {
      employeeId,
      courseId: savedProgress.courseId
    });

    return res.json({ progress: savedProgress, moduleRollup, courseRollup });
  } catch (error) {
    console.error('Failed to update lesson progress', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/progress/modules/:moduleId', async (req, res) => {
  try {
    const employeeId = resolveProgressEmployeeId(req, res);
    if (!employeeId) return;

    const moduleId = req.params.moduleId ? String(req.params.moduleId) : '';
    if (!moduleId) {
      return res.status(400).json({ error: 'module_id_required' });
    }

    const database = getDatabase();
    const { moduleDoc, courseDoc, error, status } = await resolveModuleHierarchy(
      database,
      moduleId
    );
    if (error) {
      return res.status(status).json({ error });
    }

    const { progress, error: progressError } = buildProgressEntry({
      ...req.body,
      progressType: 'module',
      employeeId,
      courseId: courseDoc._id.toString(),
      moduleId: moduleDoc._id.toString(),
      lessonId: ''
    });

    if (progressError) {
      return res.status(400).json({ error: progressError });
    }

    const savedProgress = await upsertLearningProgress(database, progress);

    const courseRollup = await computeCourseRollup(database, {
      employeeId,
      courseId: savedProgress.courseId
    });

    return res.json({ progress: savedProgress, courseRollup });
  } catch (error) {
    console.error('Failed to update module progress', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/progress/courses/:courseId', async (req, res) => {
  try {
    const employeeId = resolveProgressEmployeeId(req, res);
    if (!employeeId) return;

    const courseId = req.params.courseId ? String(req.params.courseId) : '';
    if (!courseId) {
      return res.status(400).json({ error: 'course_id_required' });
    }

    const courseObjectId = toObjectId(courseId);
    if (!courseObjectId) {
      return res.status(400).json({ error: 'invalid_course_id' });
    }

    const database = getDatabase();
    const courseDoc = await database.collection('learningCourses').findOne({ _id: courseObjectId });
    if (!courseDoc) {
      return res.status(404).json({ error: 'course_not_found' });
    }

    const { progress, error: progressError } = buildProgressEntry({
      ...req.body,
      progressType: 'course',
      employeeId,
      courseId: courseDoc._id.toString(),
      moduleId: '',
      lessonId: ''
    });

    if (progressError) {
      return res.status(400).json({ error: progressError });
    }

    const savedProgress = await upsertLearningProgress(database, progress);

    return res.json({ progress: savedProgress });
  } catch (error) {
    console.error('Failed to update course progress', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/progress/lessons/:lessonId/completion', async (req, res) => {
  try {
    const employeeId = resolveProgressEmployeeId(req, res);
    if (!employeeId) return;

    const lessonId = req.params.lessonId ? String(req.params.lessonId) : '';
    if (!lessonId) {
      return res.status(400).json({ error: 'lesson_id_required' });
    }

    const database = getDatabase();
    const { lesson, moduleDoc, courseDoc, error, status } = await resolveLessonHierarchy(
      database,
      lessonId
    );
    if (error) {
      return res.status(status).json({ error });
    }

    const { progress, error: progressError } = buildProgressEntry({
      progressType: 'lesson',
      employeeId,
      courseId: courseDoc._id.toString(),
      moduleId: moduleDoc._id.toString(),
      lessonId: lesson._id.toString(),
      completed: true,
      completionPercent: 100
    });

    if (progressError) {
      return res.status(400).json({ error: progressError });
    }

    const savedProgress = await upsertLearningProgress(database, progress);

    const moduleRollup = await computeModuleRollup(database, {
      employeeId,
      moduleId: savedProgress.moduleId,
      courseId: savedProgress.courseId
    });
    const courseRollup = await computeCourseRollup(database, {
      employeeId,
      courseId: savedProgress.courseId
    });

    return res.json({ progress: savedProgress, moduleRollup, courseRollup });
  } catch (error) {
    console.error('Failed to record lesson completion', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/progress/lessons/:lessonId/watch', async (req, res) => {
  try {
    const employeeId = resolveProgressEmployeeId(req, res);
    if (!employeeId) return;

    const lessonId = req.params.lessonId ? String(req.params.lessonId) : '';
    if (!lessonId) {
      return res.status(400).json({ error: 'lesson_id_required' });
    }

    if (!Object.prototype.hasOwnProperty.call(req.body, 'videoWatchPercent')) {
      return res.status(400).json({ error: 'video_watch_percent_required' });
    }

    const database = getDatabase();
    const { lesson, moduleDoc, courseDoc, error, status } = await resolveLessonHierarchy(
      database,
      lessonId
    );
    if (error) {
      return res.status(status).json({ error });
    }

    const { progress, error: progressError } = buildProgressEntry({
      progressType: 'lesson',
      employeeId,
      courseId: courseDoc._id.toString(),
      moduleId: moduleDoc._id.toString(),
      lessonId: lesson._id.toString(),
      videoWatchPercent: req.body.videoWatchPercent
    });

    if (progressError) {
      return res.status(400).json({ error: progressError });
    }

    const savedProgress = await upsertLearningProgress(database, progress);

    const moduleRollup = await computeModuleRollup(database, {
      employeeId,
      moduleId: savedProgress.moduleId,
      courseId: savedProgress.courseId
    });
    const courseRollup = await computeCourseRollup(database, {
      employeeId,
      courseId: savedProgress.courseId
    });

    return res.json({ progress: savedProgress, moduleRollup, courseRollup });
  } catch (error) {
    console.error('Failed to record lesson watch progress', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/progress/modules/:moduleId/rollup', async (req, res) => {
  try {
    const employeeId = resolveProgressEmployeeId(req, res);
    if (!employeeId) return;

    const moduleId = req.params.moduleId ? String(req.params.moduleId) : '';
    if (!moduleId) {
      return res.status(400).json({ error: 'module_id_required' });
    }

    const database = getDatabase();
    const { moduleDoc, courseDoc, error, status } = await resolveModuleHierarchy(
      database,
      moduleId
    );
    if (error) {
      return res.status(status).json({ error });
    }

    const moduleRollup = await computeModuleRollup(database, {
      employeeId,
      moduleId: moduleDoc._id.toString(),
      courseId: courseDoc._id.toString()
    });
    const courseRollup = await computeCourseRollup(database, {
      employeeId,
      courseId: courseDoc._id.toString()
    });

    return res.json({ moduleRollup, courseRollup });
  } catch (error) {
    console.error('Failed to record module rollup', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/progress/courses/:courseId/rollup', async (req, res) => {
  try {
    const employeeId = resolveProgressEmployeeId(req, res);
    if (!employeeId) return;

    const courseId = req.params.courseId ? String(req.params.courseId) : '';
    if (!courseId) {
      return res.status(400).json({ error: 'course_id_required' });
    }

    const courseObjectId = toObjectId(courseId);
    if (!courseObjectId) {
      return res.status(400).json({ error: 'invalid_course_id' });
    }

    const database = getDatabase();
    const courseDoc = await database.collection('learningCourses').findOne({ _id: courseObjectId });
    if (!courseDoc) {
      return res.status(404).json({ error: 'course_not_found' });
    }

    const courseRollup = await computeCourseRollup(database, {
      employeeId,
      courseId: courseDoc._id.toString()
    });

    return res.json({ courseRollup });
  } catch (error) {
    console.error('Failed to record course rollup', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/reports/completion-by-role', requireProgressReadAccess, async (req, res) => {
  try {
    const database = getDatabase();
    const scope = await resolveReportEmployeeScope(database, req.user);
    const report = await buildCompletionByRoleReport(database, scope);
    return res.json(report);
  } catch (error) {
    console.error('Failed to build role completion report', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/reports/overdue-mandatory', requireProgressReadAccess, async (req, res) => {
  try {
    const database = getDatabase();
    const scope = await resolveReportEmployeeScope(database, req.user);
    const report = await buildOverdueMandatoryReport(database, scope);
    return res.json(report);
  } catch (error) {
    console.error('Failed to build overdue mandatory report', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/reports/team-progress', requireProgressReadAccess, async (req, res) => {
  try {
    const database = getDatabase();
    const scope = await resolveReportEmployeeScope(database, req.user);
    const report = await buildTeamProgressReport(database, scope);
    return res.json(report);
  } catch (error) {
    console.error('Failed to build team progress report', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/reports/summary', requireProgressReadAccess, async (req, res) => {
  try {
    const database = getDatabase();
    const scope = await resolveReportEmployeeScope(database, req.user);
    const [completionByRole, overdueMandatory, teamProgress] = await Promise.all([
      buildCompletionByRoleReport(database, scope),
      buildOverdueMandatoryReport(database, scope),
      buildTeamProgressReport(database, scope)
    ]);

    return res.json({
      completionByRole,
      overdueMandatory,
      teamProgress
    });
  } catch (error) {
    console.error('Failed to build aggregated report summary', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/progress', async (req, res) => {
  try {
    const requestedEmployeeId = req.query.employeeId ? String(req.query.employeeId) : '';
    const employeeId = requestedEmployeeId || String(req.user?.id || '');

    if (!employeeId) {
      return res.status(400).json({ error: 'employee_id_required' });
    }

    if (requestedEmployeeId && requestedEmployeeId !== String(req.user?.id || '')) {
      if (!hasProgressOverrideAccess(req.user)) {
        return res.status(403).json({ error: 'learning_hub_progress_forbidden' });
      }
    }

    const query = { employeeId };
    if (req.query.courseId) {
      query.courseId = String(req.query.courseId);
    }

    const database = getDatabase();
    const progress = await database
      .collection('learningProgress')
      .find(query)
      .sort({ updatedAt: -1 })
      .toArray();

    return res.json(progress.map(normalizeDocument));
  } catch (error) {
    console.error('Failed to read progress', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/courses', async (req, res) => {
  try {
    const database = getDatabase();
    const statusFilter = normalizeCourseStatus(req.query.status);
    const filter = normalizeString(req.query.filter).toLowerCase();

    if (filter === 'assigned' || filter === 'available') {
      const employeeId = String(req.user?.id || '');
      if (!employeeId) {
        return res.status(400).json({ error: 'employee_id_required' });
      }

      const assignments = await database
        .collection('learningCourseAssignments')
        .find({ employeeId })
        .toArray();
      const uniqueAssignments = selectUniqueAssignments(assignments);
      const assignedCourseIds = uniqueAssignments.map(assignment => String(assignment.courseId));

      const courseQuery = statusFilter ? { status: statusFilter } : {};
      if (filter === 'assigned') {
        courseQuery._id = { $in: assignedCourseIds.map(id => new ObjectId(id)) };
      } else {
        courseQuery.status = courseQuery.status || 'published';
        courseQuery._id = { $nin: assignedCourseIds.map(id => new ObjectId(id)) };
      }

      const courses = await database
        .collection('learningCourses')
        .find(courseQuery)
        .sort({ createdAt: -1 })
        .toArray();

      const assignmentByCourse = new Map(
        uniqueAssignments.map(assignment => [String(assignment.courseId), assignment])
      );

      const response = courses.map(course => {
        const normalized = normalizeDocument(course);
        const assignment = assignmentByCourse.get(String(course._id)) || null;
        if (!assignment) return normalized;
        return {
          ...normalized,
          assignmentRequired: assignment.required,
          assignmentType: assignment.assignmentType,
          dueDate: assignment.dueDate,
          dueDays: assignment.dueDays,
          assignedAt: assignment.assignedAt
        };
      });

      return res.json({ courses: response });
    }

    const query = statusFilter ? { status: statusFilter } : {};
    const courses = await database
      .collection('learningCourses')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(courses.map(normalizeDocument));
  } catch (error) {
    console.error('Failed to list courses', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
