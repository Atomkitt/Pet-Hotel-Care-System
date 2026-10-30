// middleware/security.js
// Shared defensive security helpers: error sanitization, CSRF origin verification, and strict date validation

function sendServerError(res, contextLabel, publicMessage, err) {
  console.error(`[${contextLabel}]:`, err && err.message ? err.message : err);
  const payload = { error: publicMessage };
  if (process.env.NODE_ENV !== 'production' && err && err.message) {
    payload.details = err.message;
  }
  return res.status(500).json(payload);
}

/**
 * Defense-in-depth CSRF Origin / Referer verification for state-changing requests.
 */
function createCsrfOriginGuard(allowedOrigins) {
  const allowedSet = new Set(allowedOrigins);

  return function csrfOriginGuard(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const originHeader = req.get('origin');
    if (originHeader) {
      if (!allowedSet.has(originHeader)) {
        return res.status(403).json({
          error: 'Forbidden: Cross-origin state-changing request blocked by CSRF protection.'
        });
      }
      return next();
    }

    const refererHeader = req.get('referer');
    if (refererHeader) {
      try {
        const refOrigin = new URL(refererHeader).origin;
        if (!allowedSet.has(refOrigin)) {
          return res.status(403).json({
            error: 'Forbidden: Untrusted Referer origin blocked by CSRF protection.'
          });
        }
      } catch (_) {
        return res.status(403).json({
          error: 'Forbidden: Malformed Referer header.'
        });
      }
    }

    return next();
  };
}

function getTodayBangkokYMD() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function extractValidYMD(rawInput) {
  const trimmed = String(rawInput || '').trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+\d{2}:\d{2}:\d{2})?$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() + 1 !== month ||
    utcDate.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    ymd: `${match[1]}-${match[2]}-${match[3]}`,
    utcMs: utcDate.getTime()
  };
}

/**
 * Strictly validates check-in / check-out dates without host-timezone drift.
 */
function parseBookingDateRange(checkInInput, checkOutInput, options = {}) {
  const { rejectPast = false } = options;

  const parsedIn = extractValidYMD(checkInInput);
  const parsedOut = extractValidYMD(checkOutInput);

  if (!parsedIn || !parsedOut) {
    return {
      ok: false,
      error: 'Dates must be valid calendar dates in YYYY-MM-DD format.'
    };
  }

  if (parsedOut.utcMs <= parsedIn.utcMs) {
    return {
      ok: false,
      error: 'check_out_date must be at least 1 day after check_in_date.'
    };
  }

  if (rejectPast) {
    const todayYMD = getTodayBangkokYMD();
    if (parsedIn.ymd < todayYMD) {
      return {
        ok: false,
        error: `Check-in date cannot be in the past (minimum allowed date is ${todayYMD}).`
      };
    }
  }

  const nights = Math.max(1, Math.round((parsedOut.utcMs - parsedIn.utcMs) / 86400000));
  if (nights > 365) {
    return {
      ok: false,
      error: 'Maximum single stay duration is 365 nights.'
    };
  }

  return {
    ok: true,
    checkInYMD: parsedIn.ymd,
    checkOutYMD: parsedOut.ymd,
    checkInDt: `${parsedIn.ymd} 14:00:00`,
    checkOutDt: `${parsedOut.ymd} 12:00:00`,
    nights
  };
}

function toComparableTimestamp(dtInput) {
  if (dtInput instanceof Date) {
    return Date.UTC(
      dtInput.getFullYear(),
      dtInput.getMonth(),
      dtInput.getDate(),
      dtInput.getHours(),
      dtInput.getMinutes(),
      dtInput.getSeconds()
    );
  }
  const str = String(dtInput || '').trim();
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (match) {
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0)
    );
  }
  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Computes the peak concurrent pet count within [windowStartInput, windowEndInput)
 * across a list of bookings ({ check_in_date, check_out_date, pet_count }).
 */
function computePeakConcurrentPets(bookingsList, windowStartInput, windowEndInput) {
  if (!Array.isArray(bookingsList) || bookingsList.length === 0) {
    return 0;
  }

  const winStart = toComparableTimestamp(windowStartInput);
  const winEnd = toComparableTimestamp(windowEndInput);
  if (winEnd <= winStart) return 0;

  const intervals = [];
  const candidatePoints = new Set([winStart]);

  for (const item of bookingsList) {
    const start = Math.max(winStart, toComparableTimestamp(item.check_in_date));
    const end = Math.min(winEnd, toComparableTimestamp(item.check_out_date));
    const count = Number(item.pet_count || 0);
    if (count > 0 && start < end) {
      intervals.push({ start, end, count });
      candidatePoints.add(start);
    }
  }

  let peak = 0;
  for (const point of candidatePoints) {
    let activeAtPoint = 0;
    for (const iv of intervals) {
      if (iv.start <= point && point < iv.end) {
        activeAtPoint += iv.count;
      }
    }
    if (activeAtPoint > peak) {
      peak = activeAtPoint;
    }
  }

  return peak;
}

module.exports = {
  sendServerError,
  createCsrfOriginGuard,
  getTodayBangkokYMD,
  parseBookingDateRange,
  computePeakConcurrentPets
};
