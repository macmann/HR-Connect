const express = require('express');
const { db } = require('../db');

const router = express.Router();

const ALLOWED_ROLES = new Set(['hr', 'l&d']);

function normalizeRole(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeEmployeeId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

router.post('/roles', async (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const role = normalizeRole(payload.role);
  const employeeIds = Array.isArray(payload.employeeIds) ? payload.employeeIds : [];

  if (!ALLOWED_ROLES.has(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be hr or l&d.' });
  }

  const normalizedIds = employeeIds
    .map(normalizeEmployeeId)
    .filter(Boolean);

  if (!normalizedIds.length) {
    return res.status(400).json({ error: 'employeeIds must be a non-empty array of strings.' });
  }

  await db.read();
  db.data.employees = Array.isArray(db.data.employees) ? db.data.employees : [];

  const idSet = new Set(normalizedIds);
  let updatedCount = 0;
  let changed = false;

  db.data.employees.forEach(employee => {
    if (!employee) return;
    const employeeId = normalizeEmployeeId(employee.id);
    if (!idSet.has(employeeId)) return;
    if (employee.role !== role) {
      employee.role = role;
      changed = true;
    }
    updatedCount += 1;
  });

  if (changed) {
    await db.write();
  }

  return res.json({ updatedCount });
});

module.exports = router;
