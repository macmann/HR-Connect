const { db } = require('../db');

const SUPPORTED_LEAVE_TYPES = ['annual', 'casual', 'medical'];

const DEFAULT_LEAVE_BALANCES = {
  annual: { balance: 0, yearlyAllocation: 10, monthlyAccrual: 10 / 12, accrued: 0, taken: 0 },
  casual: { balance: 0, yearlyAllocation: 5, monthlyAccrual: 5 / 12, accrued: 0, taken: 0 },
  medical: { balance: 0, yearlyAllocation: 14, monthlyAccrual: 14 / 12, accrued: 0, taken: 0 },
  cycleStart: null,
  cycleEnd: null,
  lastAccrualRun: null
};

function getEmployeeEntitlement(employee, type) {
  const override = Number(employee?.leaveBalances?.[type]?.yearlyAllocation);
  if (Number.isFinite(override)) return override;

  const entitlementValue = Number(employee?.[`${type}LeaveEntitlement`]);
  if (Number.isFinite(entitlementValue)) return entitlementValue;

  return DEFAULT_LEAVE_BALANCES[type]?.yearlyAllocation || 0;
}

const MONTH_LOOKUP = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11
};

function roundToOneDecimal(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 10) / 10;
}

function parseEmployeeDate(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const str = String(value).trim();
  if (!str) return null;
  const lowered = str.toLowerCase();
  if (['current', 'present', 'n/a', 'na', 'yes', 'no'].includes(lowered)) return null;

  const dashMatch = str.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})$/);
  if (dashMatch) {
    const day = Number(dashMatch[1]);
    const monthKey = dashMatch[2].slice(0, 3).toLowerCase();
    const monthIndex = MONTH_LOOKUP[monthKey];
    const rawYear = Number(dashMatch[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    if (Number.isInteger(day) && Number.isInteger(monthIndex) && Number.isInteger(year)) {
      const parsed = new Date(year, monthIndex, day);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }

  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getEmployeeDateValue(employee, keys = []) {
  if (!employee || typeof employee !== 'object') return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(employee, key)) {
      const parsed = parseEmployeeDate(employee[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function startOfDay(date) {
  if (!(date instanceof Date)) return null;
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function getCurrentCycleRange(now = new Date()) {
  const base = new Date(now);
  const year = base.getMonth() >= 6 ? base.getFullYear() : base.getFullYear() - 1;
  const start = new Date(year, 6, 1);
  const end = new Date(year + 1, 5, 30, 23, 59, 59, 999);
  return { start, end };
}

function getMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getMonthEnd(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function getNextMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

function normalizeLeaveBalanceEntry(entry, defaults) {
  const baseDefaults = defaults || {
    balance: 0,
    yearlyAllocation: 0,
    monthlyAccrual: 0,
    accrued: 0,
    taken: 0
  };

  const balance = Number(
    typeof entry === 'object' && entry !== null && 'balance' in entry ? entry.balance : entry
  );
  const yearlyAllocation = Number(
    typeof entry === 'object' && entry !== null && 'yearlyAllocation' in entry
      ? entry.yearlyAllocation
      : baseDefaults.yearlyAllocation
  );
  const monthlyAccrual = Number(
    typeof entry === 'object' && entry !== null && 'monthlyAccrual' in entry
      ? entry.monthlyAccrual
      : baseDefaults.monthlyAccrual
  );
  const accrued = Number(
    typeof entry === 'object' && entry !== null && 'accrued' in entry
      ? entry.accrued
      : baseDefaults.accrued
  );
  const taken = Number(
    typeof entry === 'object' && entry !== null && 'taken' in entry
      ? entry.taken
      : baseDefaults.taken
  );

  const clampToAllocation = value => {
    if (!Number.isFinite(value)) return value;
    return Number.isFinite(yearlyAllocation) ? Math.min(value, yearlyAllocation) : value;
  };

  return {
    balance: roundToOneDecimal(
      clampToAllocation(Number.isFinite(balance) ? balance : baseDefaults.balance)
    ),
    yearlyAllocation: Number.isFinite(yearlyAllocation)
      ? yearlyAllocation
      : baseDefaults.yearlyAllocation,
    monthlyAccrual: Number.isFinite(monthlyAccrual)
      ? monthlyAccrual
      : baseDefaults.monthlyAccrual,
    accrued: roundToOneDecimal(
      clampToAllocation(Number.isFinite(accrued) ? accrued : baseDefaults.accrued)
    ),
    taken: roundToOneDecimal(Number.isFinite(taken) ? taken : baseDefaults.taken)
  };
}

function cloneDefaultLeaveBalances() {
  return {
    annual: { ...DEFAULT_LEAVE_BALANCES.annual },
    casual: { ...DEFAULT_LEAVE_BALANCES.casual },
    medical: { ...DEFAULT_LEAVE_BALANCES.medical },
    cycleStart: DEFAULT_LEAVE_BALANCES.cycleStart,
    cycleEnd: DEFAULT_LEAVE_BALANCES.cycleEnd,
    lastAccrualRun: DEFAULT_LEAVE_BALANCES.lastAccrualRun
  };
}

function resolveEmploymentStart(employee, cycleStart) {
  const internshipStart = getEmployeeDateValue(employee, [
    'internshipStartDate',
    'Start Date - Internship or Probation'
  ]);
  const fullTimeStart = getEmployeeDateValue(employee, [
    'fullTimeStartDate',
    'startDate',
    'start_date',
    'Start Date - Full Time'
  ]);
  return startOfDay(internshipStart || fullTimeStart || cycleStart);
}

function resolveEmploymentEnd(employee, cycleEnd) {
  const internshipEnd = getEmployeeDateValue(employee, [
    'internshipEndDate',
    'End Date - Internship or Probation'
  ]);
  const fullTimeStart = getEmployeeDateValue(employee, [
    'fullTimeStartDate',
    'startDate',
    'start_date',
    'Start Date - Full Time'
  ]);
  const fullTimeEnd = getEmployeeDateValue(employee, [
    'fullTimeEndDate',
    'endDate',
    'end_date',
    'End Date - Full Time'
  ]);
  const explicit = fullTimeEnd || (!fullTimeStart && internshipEnd ? internshipEnd : null);
  return startOfDay(explicit || cycleEnd);
}

function getEffectiveEmploymentWindow(employee, cycleRange) {
  const cycleStart = startOfDay(cycleRange.start);
  const cycleEnd = startOfDay(cycleRange.end);
  const employmentStart = resolveEmploymentStart(employee, cycleStart);
  const employmentEnd = resolveEmploymentEnd(employee, cycleEnd);

  const effectiveStart = employmentStart > cycleStart ? employmentStart : cycleStart;
  const effectiveEnd = employmentEnd < cycleEnd ? employmentEnd : cycleEnd;

  if (effectiveStart > effectiveEnd) {
    return null;
  }

  return { effectiveStart, effectiveEnd };
}

function listAccrualMonths(window, asOfDate) {
  if (!window) return [];
  const cutoffDate = startOfDay(asOfDate instanceof Date ? asOfDate : new Date());
  const accrualEnd = window.effectiveEnd < cutoffDate ? window.effectiveEnd : cutoffDate;
  const months = [];

  let cursor = getMonthStart(window.effectiveStart);
  while (cursor <= accrualEnd) {
    const monthEnd = getMonthEnd(cursor);
    const activeStart = cursor < window.effectiveStart ? window.effectiveStart : cursor;
    const activeEnd = monthEnd > window.effectiveEnd ? window.effectiveEnd : monthEnd;
    const accrualBoundary = monthEnd < accrualEnd ? monthEnd : accrualEnd;

    if (accrualBoundary >= activeStart) {
      months.push(cursor);
    }

    cursor = getNextMonth(cursor);
  }

  return months;
}

function calculateAccruedLeaveForEmployee(employee, cycleRange, asOfDate = new Date()) {
  const window = getEffectiveEmploymentWindow(employee, cycleRange);
  if (!window) {
    return { annual: 0, casual: 0, medical: 0, monthsAccrued: [] };
  }

  const accrualMonths = listAccrualMonths(window, asOfDate);
  const monthlyAccruals = Object.fromEntries(
    SUPPORTED_LEAVE_TYPES.map(type => {
      const entitlement = getEmployeeEntitlement(employee, type);
      return [type, entitlement / 12];
    })
  );

  const totals = { annual: 0, casual: 0, medical: 0 };
  accrualMonths.forEach(() => {
    SUPPORTED_LEAVE_TYPES.forEach(type => {
      totals[type] += monthlyAccruals[type] || DEFAULT_LEAVE_BALANCES[type].monthlyAccrual;
    });
  });

  const roundedTotals = Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, roundToOneDecimal(value)])
  );

  return { ...roundedTotals, monthsAccrued: accrualMonths };
}

function buildHolidaySet(holidays = []) {
  return new Set(
    holidays
      .map(entry => (typeof entry === 'string' ? entry : entry?.date))
      .filter(Boolean)
  );
}

function getLeaveDaysWithin(app, startDate, endDate, holidaySet = new Set()) {
  const from = new Date(app.from);
  const to = new Date(app.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;

  const cappedStart = from < startDate ? new Date(startDate) : from;
  const cappedEnd = to > endDate ? new Date(endDate) : to;
  if (cappedEnd < cappedStart) return 0;

  if (app.halfDay) {
    const isWithinRange = cappedStart.getTime() === from.getTime();
    if (!isWithinRange) return 0;
    const day = from.getDay();
    const iso = from.toISOString().split('T')[0];
    return day === 0 || day === 6 || holidaySet.has(iso) ? 0 : 0.5;
  }

  let days = 0;
  const cursor = new Date(cappedStart);
  while (cursor <= cappedEnd) {
    const iso = cursor.toISOString().split('T')[0];
    const day = cursor.getDay();
    if (day !== 0 && day !== 6 && !holidaySet.has(iso)) {
      days += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

function calculateLeaveTakenForEmployee(employeeId, applications, cycleRange, asOfDate, holidays) {
  const totals = { annual: 0, casual: 0, medical: 0 };
  if (!Array.isArray(applications)) return totals;

  const startBoundary = startOfDay(cycleRange.start);
  const endBoundary = (() => {
    const endCap = startOfDay(asOfDate instanceof Date ? asOfDate : new Date());
    const capped = cycleRange.end < endCap ? cycleRange.end : endCap;
    return startOfDay(capped);
  })();

  const holidaySet = buildHolidaySet(holidays);

  applications.forEach(app => {
    if (!app || app.employeeId != employeeId) return;
    const status = String(app.status || '').toLowerCase();
    if (status !== 'approved') return;
    if (!SUPPORTED_LEAVE_TYPES.includes(app.type)) return;

    const from = new Date(app.from);
    const to = new Date(app.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return;
    if (to < startBoundary || from > endBoundary) return;

    const days = getLeaveDaysWithin(app, startBoundary, endBoundary, holidaySet);
    totals[app.type] = roundToOneDecimal((totals[app.type] || 0) + days);
  });

  return totals;
}

function buildEmployeeLeaveState(employee, applications, options = {}) {
  const asOfDate = options.asOfDate instanceof Date ? options.asOfDate : new Date();
  const cycleRange = options.cycleRange || getCurrentCycleRange(asOfDate);
  const holidays = options.holidays || [];

  const accrued = calculateAccruedLeaveForEmployee(employee, cycleRange, asOfDate);
  const taken = calculateLeaveTakenForEmployee(
    employee?.id,
    applications,
    cycleRange,
    asOfDate,
    holidays
  );

  const balances = cloneDefaultLeaveBalances();
  SUPPORTED_LEAVE_TYPES.forEach(type => {
    const defaults = DEFAULT_LEAVE_BALANCES[type];
    const entitlement = getEmployeeEntitlement(employee, type);
    const monthlyAccrual = entitlement / 12;
    const overriddenDefaults = { ...defaults, yearlyAllocation: entitlement, monthlyAccrual };
    const accruedValue = accrued[type] || 0;
    const takenValue = taken[type] || 0;
    const cappedAccrued = Math.min(accruedValue, entitlement);
    const balance = roundToOneDecimal(cappedAccrued - takenValue);
    balances[type] = {
      ...normalizeLeaveBalanceEntry(employee?.leaveBalances?.[type], overriddenDefaults),
      monthlyAccrual,
      yearlyAllocation: entitlement,
      accrued: roundToOneDecimal(cappedAccrued),
      taken: roundToOneDecimal(takenValue),
      balance
    };
  });

  balances.cycleStart = cycleRange.start;
  balances.cycleEnd = cycleRange.end;
  balances.lastAccrualRun = asOfDate;

  return { balances, accrued, taken, cycleRange };
}

async function recalculateLeaveBalancesForCycle(asOfDate = new Date()) {
  await db.read();

  db.data = db.data || {};
  db.data.employees = Array.isArray(db.data.employees) ? db.data.employees : [];
  db.data.applications = Array.isArray(db.data.applications) ? db.data.applications : [];
  db.data.holidays = Array.isArray(db.data.holidays) ? db.data.holidays : [];

  const employees = db.data.employees;
  const applications = db.data.applications;
  const holidays = db.data.holidays;
  const cycleRange = getCurrentCycleRange(asOfDate);

  let updated = 0;

  employees.forEach(emp => {
    const { balances } = buildEmployeeLeaveState(emp, applications, {
      asOfDate,
      cycleRange,
      holidays
    });

    const hasChanged = JSON.stringify(emp.leaveBalances || {}) !== JSON.stringify(balances);
    emp.leaveBalances = balances;
    if (hasChanged) {
      updated += 1;
    }
  });

  if (updated > 0) {
    await db.write();
  }

  return {
    processed: employees.length,
    updated,
    cycleStart: cycleRange.start,
    cycleEnd: cycleRange.end,
    asOf: asOfDate
  };
}

async function accrueMonthlyLeave(now = new Date()) {
  return recalculateLeaveBalancesForCycle(now);
}

module.exports = {
  accrueMonthlyLeave,
  recalculateLeaveBalancesForCycle,
  calculateAccruedLeaveForEmployee,
  calculateLeaveTakenForEmployee,
  buildEmployeeLeaveState,
  getCurrentCycleRange,
  getEffectiveEmploymentWindow,
  cloneDefaultLeaveBalances,
  DEFAULT_LEAVE_BALANCES,
  SUPPORTED_LEAVE_TYPES,
  roundToOneDecimal,
  listAccrualMonths,
  normalizeLeaveBalanceEntry
};
