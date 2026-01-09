const { getDatabase, db } = require('../db');

const INACTIVE_EMPLOYEE_STATUSES = new Set([
  'inactive',
  'deactivated',
  'disabled',
  'terminated'
]);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRole(role) {
  return normalizeString(role).toLowerCase();
}

function normalizeBoolean(value) {
  return value === true || value === 'true';
}

function normalizeDueDays(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.floor(parsed);
  return Math.max(0, rounded);
}

function isActiveEmployeeStatus(status) {
  const normalized = normalizeString(status).toLowerCase();
  if (!normalized) return true;
  return !INACTIVE_EMPLOYEE_STATUSES.has(normalized);
}

function findEmployeeRole(employee) {
  if (!employee || typeof employee !== 'object') return '';
  const keys = Object.keys(employee).filter(key => typeof key === 'string');
  const roleKey = keys.find(key => key.trim().toLowerCase().includes('role'));
  if (!roleKey) return '';
  return normalizeString(employee[roleKey]);
}

function getUserRoles(user, employee) {
  const roles = [];
  if (Array.isArray(user?.roles)) {
    roles.push(...user.roles.map(normalizeRole).filter(Boolean));
  }
  const userRole = normalizeRole(user?.role);
  if (userRole) {
    roles.push(userRole);
  }
  const employeeRole = normalizeRole(findEmployeeRole(employee));
  if (employeeRole) {
    roles.push(employeeRole);
  }
  return Array.from(new Set(roles)).filter(Boolean);
}

function buildRoleAssignment(payload = {}, { userId } = {}) {
  const courseId = normalizeString(payload.courseId);
  if (!courseId) {
    return { error: 'course_id_required' };
  }

  const role = normalizeRole(payload.role);
  if (!role) {
    return { error: 'role_required' };
  }

  const dueDays = normalizeDueDays(payload.dueDays);
  if (Object.prototype.hasOwnProperty.call(payload, 'dueDays') && dueDays === null) {
    return { error: 'invalid_due_days' };
  }

  const now = new Date();
  const roleAssignment = {
    courseId: String(courseId),
    role,
    required: normalizeBoolean(payload.required),
    dueDays,
    createdAt: now,
    updatedAt: now,
    createdBy: userId || null,
    updatedBy: userId || null
  };

  return { roleAssignment };
}

function applyRoleAssignmentUpdates(payload = {}, { userId } = {}) {
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'courseId')) {
    const courseId = normalizeString(payload.courseId);
    if (!courseId) {
      return { error: 'course_id_required' };
    }
    updates.courseId = String(courseId);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'role')) {
    const role = normalizeRole(payload.role);
    if (!role) {
      return { error: 'role_required' };
    }
    updates.role = role;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'required')) {
    updates.required = normalizeBoolean(payload.required);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'dueDays')) {
    const dueDays = normalizeDueDays(payload.dueDays);
    if (dueDays === null && payload.dueDays !== null && payload.dueDays !== '') {
      return { error: 'invalid_due_days' };
    }
    updates.dueDays = dueDays;
  }

  if (!Object.keys(updates).length) {
    return { error: 'updates_required' };
  }

  updates.updatedAt = new Date();
  if (userId) {
    updates.updatedBy = userId;
  }

  return { updates };
}

function calculateDueDate(now, dueDays) {
  if (!Number.isFinite(dueDays)) return null;
  return new Date(now.getTime() + dueDays * 24 * 60 * 60 * 1000);
}

async function reconcileLearningRoleAssignments(options = {}) {
  const database = options.database || getDatabase();
  const now = options.now instanceof Date ? options.now : new Date();

  const [roleAssignments, users, employees] = await Promise.all([
    database.collection('learningRoleAssignments').find().toArray(),
    database.collection('users').find().toArray(),
    database.collection('employees').find().toArray()
  ]);

  const roleAssignmentsByRole = new Map();
  roleAssignments.forEach(roleAssignment => {
    const role = normalizeRole(roleAssignment?.role);
    if (!role || !roleAssignment?.courseId) return;
    const list = roleAssignmentsByRole.get(role) || [];
    list.push(roleAssignment);
    roleAssignmentsByRole.set(role, list);
  });

  if (!roleAssignmentsByRole.size) {
    return {
      employeesProcessed: 0,
      assignmentsUpserted: 0,
      assignmentsRemoved: 0
    };
  }

  const employeesById = new Map();
  employees.forEach(employee => {
    if (employee?.id === undefined || employee?.id === null) return;
    employeesById.set(String(employee.id), employee);
  });

  const employeeIds = users
    .map(user => (user?.employeeId === undefined || user?.employeeId === null)
      ? ''
      : String(user.employeeId))
    .filter(Boolean);

  const existingAssignments = employeeIds.length
    ? await database.collection('learningCourseAssignments').find({
        employeeId: { $in: employeeIds },
        assignmentType: { $in: ['employee', 'role_auto'] }
      }).toArray()
    : [];

  const manualAssignmentKeys = new Set();
  const roleAutoAssignments = [];
  existingAssignments.forEach(assignment => {
    const employeeId = assignment?.employeeId ? String(assignment.employeeId) : '';
    const courseId = assignment?.courseId ? String(assignment.courseId) : '';
    if (!employeeId || !courseId) return;
    const key = `${employeeId}:${courseId}`;
    if (assignment.assignmentType === 'employee') {
      manualAssignmentKeys.add(key);
    } else if (assignment.assignmentType === 'role_auto') {
      roleAutoAssignments.push(assignment);
    }
  });

  const desiredAssignments = [];
  const allowedRoleAssignmentIdsByEmployee = new Map();
  const selectedAssignmentByCourse = new Map();
  let employeesProcessed = 0;

  users.forEach(user => {
    const employeeId = user?.employeeId === undefined || user?.employeeId === null
      ? ''
      : String(user.employeeId);
    if (!employeeId) return;

    const employee = employeesById.get(employeeId) || null;
    if (employee && !isActiveEmployeeStatus(employee.status)) {
      return;
    }

    const roles = getUserRoles(user, employee);
    if (!roles.length) {
      return;
    }

    employeesProcessed += 1;
    const allowedRoleAssignmentIds = new Set();
    const assignedCourses = new Set();

    roles.forEach(role => {
      const assignments = roleAssignmentsByRole.get(role) || [];
      assignments.forEach(roleAssignment => {
        if (!roleAssignment?.courseId || !roleAssignment?._id) return;
        const courseId = String(roleAssignment.courseId);
        const key = `${employeeId}:${courseId}`;
        const assignmentId = String(roleAssignment._id);

        allowedRoleAssignmentIds.add(assignmentId);
        if (manualAssignmentKeys.has(key)) {
          return;
        }
        if (assignedCourses.has(courseId)) {
          return;
        }
        assignedCourses.add(courseId);
        selectedAssignmentByCourse.set(key, assignmentId);
        desiredAssignments.push({
          employeeId,
          role,
          roleAssignment
        });
      });
    });

    if (allowedRoleAssignmentIds.size) {
      allowedRoleAssignmentIdsByEmployee.set(employeeId, allowedRoleAssignmentIds);
    }
  });

  const bulkOps = [];
  const deleteIds = [];

  roleAutoAssignments.forEach(assignment => {
    const employeeId = assignment?.employeeId ? String(assignment.employeeId) : '';
    const courseId = assignment?.courseId ? String(assignment.courseId) : '';
    if (!employeeId || !courseId) return;
    const allowedIds = allowedRoleAssignmentIdsByEmployee.get(employeeId);
    const assignmentId = assignment?.sourceRoleAssignmentId
      ? String(assignment.sourceRoleAssignmentId)
      : '';
    const key = `${employeeId}:${courseId}`;
    const selectedAssignmentId = selectedAssignmentByCourse.get(key);

    if (!allowedIds || !allowedIds.has(assignmentId) || selectedAssignmentId !== assignmentId) {
      if (assignment._id) {
        deleteIds.push(assignment._id);
      }
    }
  });

  desiredAssignments.forEach(({ employeeId, role, roleAssignment }) => {
    const assignmentId = String(roleAssignment._id);
    const courseId = String(roleAssignment.courseId);
    const dueDays = Number.isFinite(roleAssignment.dueDays)
      ? roleAssignment.dueDays
      : normalizeDueDays(roleAssignment.dueDays);
    const dueDate = calculateDueDate(now, dueDays);

    const assignment = {
      courseId,
      assignmentType: 'role_auto',
      role,
      employeeId,
      required: Boolean(roleAssignment.required),
      dueDate,
      assignedBy: null,
      sourceRoleAssignmentId: assignmentId,
      updatedAt: now
    };

    bulkOps.push({
      updateOne: {
        filter: {
          employeeId,
          courseId,
          assignmentType: 'role_auto',
          sourceRoleAssignmentId: assignmentId
        },
        update: {
          $set: assignment,
          $setOnInsert: { assignedAt: now }
        },
        upsert: true
      }
    });
  });

  if (deleteIds.length) {
    deleteIds.forEach(id => {
      bulkOps.push({
        deleteOne: {
          filter: { _id: id }
        }
      });
    });
  }

  if (bulkOps.length) {
    await database.collection('learningCourseAssignments').bulkWrite(bulkOps, { ordered: false });
    db.invalidateCache?.();
  }

  return {
    employeesProcessed,
    assignmentsUpserted: desiredAssignments.length,
    assignmentsRemoved: deleteIds.length
  };
}

module.exports = {
  buildRoleAssignment,
  applyRoleAssignmentUpdates,
  reconcileLearningRoleAssignments
};
