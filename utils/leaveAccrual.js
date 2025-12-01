const { db } = require('../db');

const DEFAULT_ENTITLEMENTS = {
  annual: 10,
  casual: 5,
  medical: 14
};

const SUPPORTED_LEAVE_TYPES = ['annual', 'casual', 'medical'];

function toDateOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfDay(date) {
  if (!(date instanceof Date)) return null;
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function getCurrentLeaveCycle(dateNow = new Date()) {
  const now = new Date(dateNow);
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const cycleStart = new Date(year, 6, 1);
  const cycleEnd = new Date(year + 1, 5, 30, 23, 59, 59, 999);
  const yearLabel = `${year}-${year + 1}`;
  return { cycleStart, cycleEnd, yearLabel };
}

function computeMonthsServedInCycle(employee, dateNow = new Date()) {
  const { cycleStart } = getCurrentLeaveCycle(dateNow);
  const now = new Date(dateNow);
  const primaryStart = toDateOrNull(employee?.internshipStartDate);
  const secondaryStart = toDateOrNull(employee?.fullTimeStartDate);
  const effectiveStartDate = primaryStart || secondaryStart || cycleStart;
  const effectiveStartForCycle = effectiveStartDate > cycleStart ? effectiveStartDate : cycleStart;

  const startMonthAnchor = new Date(
    effectiveStartForCycle.getFullYear(),
    effectiveStartForCycle.getMonth(),
    1
  );
  let months =
    (now.getFullYear() - startMonthAnchor.getFullYear()) * 12 +
    (now.getMonth() - startMonthAnchor.getMonth());
  if (now.getDate() < effectiveStartForCycle.getDate()) {
    months -= 1;
  }

  if (!Number.isFinite(months) || months < 0) months = 0;
  if (months > 12) months = 12;

  return months;
}

function computeAccruedLeaveBalance({ yearEntitlement, monthsServedInCycle, totalLeaveTaken }) {
  const earned = yearEntitlement * (monthsServedInCycle / 12);
  const balance = earned - (totalLeaveTaken || 0);
  return { earned, balance };
}

function buildHolidaySet(holidays = []) {
  return new Set(
    (holidays || [])
      .map(entry => (typeof entry === 'string' ? entry : entry?.date))
      .filter(Boolean)
  );
}

function calculateLeaveDaysWithinRange(app, rangeStart, rangeEnd, holidaySet = new Set()) {
  const from = new Date(app.from);
  const to = new Date(app.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;

  const start = from < rangeStart ? new Date(rangeStart) : from;
  const end = to > rangeEnd ? new Date(rangeEnd) : to;
  if (end < start) return 0;

  if (app.halfDay) {
    if (from < rangeStart || from > rangeEnd) return 0;
    const day = from.getDay();
    const iso = from.toISOString().split('T')[0];
    return day === 0 || day === 6 || holidaySet.has(iso) ? 0 : 0.5;
  }

  let days = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getDay();
    const iso = cursor.toISOString().split('T')[0];
    if (day !== 0 && day !== 6 && !holidaySet.has(iso)) {
      days += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

async function computeAllLeaveBalances(employee, { dateNow = new Date(), applications, holidays } = {}) {
  const { cycleStart, cycleEnd } = getCurrentLeaveCycle(dateNow);
  const rangeStart = startOfDay(cycleStart);
  const today = startOfDay(dateNow);
  const rangeEnd = today && cycleEnd < today ? cycleEnd : today;

  if (!applications || !Array.isArray(applications)) {
    await db.read();
    applications = Array.isArray(db.data?.applications) ? db.data.applications : [];
    if (!holidays && Array.isArray(db.data?.holidays)) {
      holidays = db.data.holidays;
    }
  }

  const holidaySet = buildHolidaySet(holidays);
  const monthsServedInCycle = computeMonthsServedInCycle(employee, dateNow);

  const totals = { annual: 0, casual: 0, medical: 0 };
  (applications || []).forEach(app => {
    if (!app || app.employeeId != employee?.id) return;
    const status = String(app.status || '').toLowerCase();
    if (status !== 'approved') return;
    const type = String(app.type || '').toLowerCase();
    if (!SUPPORTED_LEAVE_TYPES.includes(type)) return;
    const days = calculateLeaveDaysWithinRange(app, rangeStart, rangeEnd, holidaySet);
    totals[type] += days;
  });

  const balances = {};
  SUPPORTED_LEAVE_TYPES.forEach(type => {
    const entitlementValue = Number(employee?.[`${type}LeaveEntitlement`]);
    const yearEntitlement = Number.isFinite(entitlementValue)
      ? entitlementValue
      : DEFAULT_ENTITLEMENTS[type];
    const { earned, balance } = computeAccruedLeaveBalance({
      yearEntitlement,
      monthsServedInCycle,
      totalLeaveTaken: totals[type]
    });
    balances[type] = {
      entitlement: yearEntitlement,
      earned,
      taken: totals[type] || 0,
      balance
    };
  });

  return balances;
}

module.exports = {
  computeAccruedLeaveBalance,
  computeAllLeaveBalances,
  computeMonthsServedInCycle,
  getCurrentLeaveCycle,
  DEFAULT_ENTITLEMENTS,
  SUPPORTED_LEAVE_TYPES
};
