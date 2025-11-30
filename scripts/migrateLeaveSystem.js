const { db } = require('../db');

const DEFAULT_LEAVE_BALANCES = {
  annual: { balance: 0, yearlyAllocation: 10, monthlyAccrual: 10 / 12 },
  casual: { balance: 0, yearlyAllocation: 5, monthlyAccrual: 5 / 12 },
  medical: { balance: 0, yearlyAllocation: 14, monthlyAccrual: 14 / 12 }
};

function cloneDefaultLeaveBalances() {
  return {
    annual: { ...DEFAULT_LEAVE_BALANCES.annual },
    casual: { ...DEFAULT_LEAVE_BALANCES.casual },
    medical: { ...DEFAULT_LEAVE_BALANCES.medical },
    accrualStartDate: null,
    nextAccrualMonth: null
  };
}

function normalizeNullableDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function datesEqual(a, b) {
  const first = normalizeNullableDate(a);
  const second = normalizeNullableDate(b);

  if (!first && !second) return true;
  if (!first || !second) return false;
  return first.getTime() === second.getTime();
}

function getCurrentCycleStart(now = new Date()) {
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(year, 6, 1);
}

function getFirstDayOfNextMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

function getFirstUpcomingMonthStart(fromDate, now = new Date()) {
  const todayMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let candidate = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);

  while (candidate < fromDate) {
    candidate = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 1);
  }

  while (candidate < todayMonthStart) {
    candidate = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 1);
  }

  return candidate;
}

function migrateEmployee(emp, options = {}) {
  if (!emp || typeof emp !== 'object') return false;

  const now = options.now instanceof Date ? options.now : new Date();
  let updated = false;

  const normalizedEffectiveStart = normalizeNullableDate(emp.effectiveStartDate);
  const internshipStart = normalizeNullableDate(emp.internshipStartDate);
  const startDate = normalizeNullableDate(emp.startDate);
  const fallbackStartDate = getCurrentCycleStart(now);
  const effectiveStartDate =
    normalizedEffectiveStart || internshipStart || startDate || fallbackStartDate;

  if (!datesEqual(emp.effectiveStartDate, effectiveStartDate)) {
    emp.effectiveStartDate = effectiveStartDate;
    updated = true;
  }

  if (!emp.leaveBalances || typeof emp.leaveBalances !== 'object') {
    emp.leaveBalances = cloneDefaultLeaveBalances();
    updated = true;
  }

  const accrualStartDate = normalizeNullableDate(emp.leaveBalances.accrualStartDate);
  if (!datesEqual(emp.leaveBalances.accrualStartDate, accrualStartDate)) {
    emp.leaveBalances.accrualStartDate = accrualStartDate;
    updated = true;
  }

  if (!accrualStartDate && effectiveStartDate) {
    const derivedAccrual = getFirstDayOfNextMonth(effectiveStartDate);
    if (!datesEqual(emp.leaveBalances.accrualStartDate, derivedAccrual)) {
      emp.leaveBalances.accrualStartDate = derivedAccrual;
      updated = true;
    }
  }

  const nextAccrualMonth = normalizeNullableDate(emp.leaveBalances.nextAccrualMonth);
  if (!datesEqual(emp.leaveBalances.nextAccrualMonth, nextAccrualMonth)) {
    emp.leaveBalances.nextAccrualMonth = nextAccrualMonth;
    updated = true;
  }

  if (!nextAccrualMonth && emp.leaveBalances.accrualStartDate) {
    const derivedNext = getFirstUpcomingMonthStart(emp.leaveBalances.accrualStartDate, now);
    if (!datesEqual(emp.leaveBalances.nextAccrualMonth, derivedNext)) {
      emp.leaveBalances.nextAccrualMonth = derivedNext;
      updated = true;
    }
  }

  return updated;
}

async function migrateLeaveSystem(options = {}) {
  const { forceRead = true, now = new Date() } = options;

  await db.read({ force: forceRead });

  db.data = db.data || {};
  db.data.employees = Array.isArray(db.data.employees) ? db.data.employees : [];

  let updatedCount = 0;
  const { employees } = db.data;

  employees.forEach((emp, idx) => {
    const changed = migrateEmployee(emp, { now });
    if (changed) {
      updatedCount += 1;
      console.log(`Updated employee at index ${idx}`);
    }
  });

  if (updatedCount > 0) {
    await db.write();
  }

  const summary = {
    totalEmployees: employees.length,
    updatedCount
  };

  console.log(`Processed ${summary.totalEmployees} employees; updated ${summary.updatedCount}.`);

  return summary;
}

module.exports = {
  migrateLeaveSystem,
  migrateEmployee,
  DEFAULT_LEAVE_BALANCES,
  cloneDefaultLeaveBalances,
  normalizeNullableDate,
  getCurrentCycleStart,
  getFirstDayOfNextMonth,
  getFirstUpcomingMonthStart
};

if (require.main === module) {
  migrateLeaveSystem()
    .then(summary => {
      console.log('Leave system migration complete.', summary);
      process.exit(0);
    })
    .catch(error => {
      console.error('Leave system migration failed:', error);
      process.exit(1);
    });
}
