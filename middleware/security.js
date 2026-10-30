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

module.exports = {
  sendServerError,
  createCsrfOriginGuard,
  getTodayBangkokYMD,
  parseBookingDateRange
};
