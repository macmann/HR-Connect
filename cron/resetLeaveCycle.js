const cron = require('node-cron');
const { db } = require('../db');

const SUPPORTED_LEAVE_TYPES = ['annual', 'casual', 'medical'];
const DEFAULT_LEAVE_BALANCES = {
  annual: { balance: 0, yearlyAllocation: 10, monthlyAccrual: 10 / 12 },
  casual: { balance: 0, yearlyAllocation: 5, monthlyAccrual: 5 / 12 },
  medical: { balance: 0, yearlyAllocation: 14, monthlyAccrual: 14 / 12 }
};

function normalizeNullableDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

function normalizeLeaveBalanceEntry(entry, defaults) {
  const baseDefaults = defaults || { balance: 0, yearlyAllocation: 0, monthlyAccrual: 0 };
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

  return {
    balance: Number.isFinite(balance) ? balance : baseDefaults.balance,
    yearlyAllocation: Number.isFinite(yearlyAllocation)
      ? yearlyAllocation
      : baseDefaults.yearlyAllocation,
    monthlyAccrual: Number.isFinite(monthlyAccrual)
      ? monthlyAccrual
      : baseDefaults.monthlyAccrual
  };
}

async function resetLeaveCycle(now = new Date()) {
  await db.read();

  db.data = db.data || {};
  db.data.employees = Array.isArray(db.data.employees) ? db.data.employees : [];

  const employees = db.data.employees;
  let updatedCount = 0;

  employees.forEach(emp => {
    if (!emp || typeof emp !== 'object') return;

    const nowDate = now instanceof Date ? now : new Date();
    const normalizedEffectiveStart = normalizeNullableDate(emp.effectiveStartDate);
    const internshipStart = normalizeNullableDate(emp.internshipStartDate);
    const startDate = normalizeNullableDate(emp.startDate);
    const fallbackStart = getCurrentCycleStart(nowDate);
    const effectiveStartDate = normalizedEffectiveStart || internshipStart || startDate || fallbackStart;

    emp.leaveBalances = emp.leaveBalances && typeof emp.leaveBalances === 'object'
      ? { ...emp.leaveBalances }
      : {};

    SUPPORTED_LEAVE_TYPES.forEach(type => {
      const defaults = DEFAULT_LEAVE_BALANCES[type];
      const normalized = normalizeLeaveBalanceEntry(emp.leaveBalances[type], defaults);
      emp.leaveBalances[type] = { ...defaults, ...normalized, balance: 0 };
    });

    const accrualStart = normalizeNullableDate(emp.leaveBalances.accrualStartDate);
    let accrualStartDate = accrualStart;
    if (!accrualStartDate && effectiveStartDate) {
      accrualStartDate = getFirstDayOfNextMonth(effectiveStartDate);
    }

    const nextAccrual = normalizeNullableDate(emp.leaveBalances.nextAccrualMonth);
    let nextAccrualMonth;
    if (nextAccrual) {
      nextAccrualMonth = getFirstUpcomingMonthStart(nextAccrual, nowDate);
    } else if (accrualStartDate) {
      nextAccrualMonth = getFirstUpcomingMonthStart(accrualStartDate, nowDate);
    } else {
      nextAccrualMonth = getFirstUpcomingMonthStart(getFirstDayOfNextMonth(fallbackStart), nowDate);
    }

    const hadChanges =
      emp.leaveBalances.accrualStartDate !== accrualStartDate ||
      emp.leaveBalances.nextAccrualMonth !== nextAccrualMonth ||
      SUPPORTED_LEAVE_TYPES.some(type => {
        const current = emp.leaveBalances[type];
        return current && current.balance !== 0;
      });

    emp.leaveBalances.accrualStartDate = accrualStartDate;
    emp.leaveBalances.nextAccrualMonth = nextAccrualMonth;

    if (hadChanges) {
      updatedCount += 1;
    }
  });

  if (updatedCount > 0) {
    await db.write();
  }

  return { processed: employees.length, updated: updatedCount };
}

const resetLeaveCycleJob = cron.schedule('0 1 1 7 *', async () => {
  console.log('[CRON] Starting leave cycle reset job');
  try {
    const result = await resetLeaveCycle();
    console.log('[CRON] Leave cycle reset completed', result);
  } catch (error) {
    console.error('[CRON] Leave cycle reset failed', error);
  }
});

module.exports = resetLeaveCycleJob;
