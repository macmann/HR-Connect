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

function getMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getNextMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
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

function accrueEmployeeLeave(emp, monthStart) {
  if (!emp || typeof emp !== 'object') return false;

  if (!emp.leaveBalances || typeof emp.leaveBalances !== 'object') {
    emp.leaveBalances = {
      annual: { ...DEFAULT_LEAVE_BALANCES.annual },
      casual: { ...DEFAULT_LEAVE_BALANCES.casual },
      medical: { ...DEFAULT_LEAVE_BALANCES.medical },
      accrualStartDate: null,
      nextAccrualMonth: null
    };
  }

  const accrualStartDate = normalizeNullableDate(emp.leaveBalances.accrualStartDate);
  const nextAccrualMonth = normalizeNullableDate(emp.leaveBalances.nextAccrualMonth);

  emp.leaveBalances.accrualStartDate = accrualStartDate;
  emp.leaveBalances.nextAccrualMonth = nextAccrualMonth;

  if (!accrualStartDate) return false;

  const accrualStartMonth = getMonthStart(accrualStartDate);
  const targetAccrualMonth = nextAccrualMonth ? getMonthStart(nextAccrualMonth) : accrualStartMonth;

  if (monthStart < accrualStartMonth || monthStart < targetAccrualMonth) {
    return false;
  }

  let updated = false;

  SUPPORTED_LEAVE_TYPES.forEach(type => {
    const defaults = DEFAULT_LEAVE_BALANCES[type];
    const current = normalizeLeaveBalanceEntry(emp.leaveBalances[type], defaults);
    const newBalance = current.balance + current.monthlyAccrual;

    emp.leaveBalances[type] = { ...defaults, ...current, balance: newBalance };
    updated = true;
  });

  emp.leaveBalances.nextAccrualMonth = getNextMonth(targetAccrualMonth);

  return updated;
}

async function accrueMonthlyLeave(now = new Date()) {
  await db.read();

  db.data = db.data || {};
  db.data.employees = Array.isArray(db.data.employees) ? db.data.employees : [];

  const employees = db.data.employees;
  const monthStart = getMonthStart(now);

  let accruedCount = 0;

  employees.forEach(emp => {
    const accrued = accrueEmployeeLeave(emp, monthStart);
    if (accrued) {
      accruedCount += 1;
    }
  });

  if (accruedCount > 0) {
    await db.write();
  }

  return { processed: employees.length, accrued: accruedCount };
}

module.exports = {
  accrueMonthlyLeave
};
