import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// ============ Advanced Security Configuration ============

const ADVANCED_SECURITY_CONFIG = {
  // Request signing
  signatureHeader: 'X-Signature',
  timestampHeader: 'X-Timestamp',
  nonceHeader: 'X-Nonce',

  // Replay protection
  maxTimestampAge: 300000,      // 5 minutes
  nonceExpiry: 600000,          // 10 minutes

  // Brute force protection
  maxLoginAttempts: 5,
  lockoutDuration: 900000,      // 15 minutes

  // Fingerprinting
  fingerprintHeaders: ['user-agent', 'accept-language', 'accept-encoding'],

  // Secret rotation
  keyRotationInterval: 86400000, // 24 hours
};

// ============ In-Memory Security Stores ============

// Nonce store for replay protection
const usedNonces = new Map<string, number>();

// Login attempt tracking
const loginAttempts = new Map<string, { count: number; lastAttempt: number; lockedUntil?: number }>();

// Client fingerprints
const clientFingerprints = new Map<string, string>();

// API key hash store (for secure comparison)
const apiKeyHashes = new Map<string, string>();

// ============ Cryptographic Functions ============

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  salt = salt || crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const result = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(result.hash), Buffer.from(hash));
}

export function generateSecureToken(length = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export function generateHMAC(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyHMAC(payload: string, signature: string, secret: string): boolean {
  const expected = generateHMAC(payload, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ============ Replay Protection ============

export function replayProtection(req: Request, res: Response, next: NextFunction): void {
  const timestamp = req.headers[ADVANCED_SECURITY_CONFIG.timestampHeader.toLowerCase()] as string;
  const nonce = req.headers[ADVANCED_SECURITY_CONFIG.nonceHeader.toLowerCase()] as string;

  // Skip if no timestamp/nonce (for public endpoints)
  if (!timestamp && !nonce) {
    next();
    return;
  }

  // Validate timestamp
  if (timestamp) {
    const requestTime = parseInt(timestamp, 10);
    const now = Date.now();

    if (isNaN(requestTime) || Math.abs(now - requestTime) > ADVANCED_SECURITY_CONFIG.maxTimestampAge) {
      res.status(400).json({
        success: false,
        error: 'Request timestamp expired or invalid',
        code: 'TIMESTAMP_INVALID',
      });
      return;
    }
  }

  // Validate nonce (prevent replay)
  if (nonce) {
    if (usedNonces.has(nonce)) {
      res.status(400).json({
        success: false,
        error: 'Request nonce already used (replay detected)',
        code: 'NONCE_REUSED',
      });
      return;
    }

    // Store nonce
    usedNonces.set(nonce, Date.now());

    // Clean old nonces
    const cutoff = Date.now() - ADVANCED_SECURITY_CONFIG.nonceExpiry;
    for (const [key, time] of usedNonces.entries()) {
      if (time < cutoff) {
        usedNonces.delete(key);
      }
    }
  }

  next();
}

// ============ Request Signature Verification ============

export function signatureVerification(secret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const signature = req.headers[ADVANCED_SECURITY_CONFIG.signatureHeader.toLowerCase()] as string;
    const timestamp = req.headers[ADVANCED_SECURITY_CONFIG.timestampHeader.toLowerCase()] as string;

    // Skip if no signature required
    if (!signature) {
      next();
      return;
    }

    // Build payload to verify
    const payload = [
      req.method,
      req.path,
      timestamp || '',
      req.headers[ADVANCED_SECURITY_CONFIG.nonceHeader.toLowerCase()] || '',
      JSON.stringify(req.body || {}),
    ].join('|');

    if (!verifyHMAC(payload, signature, secret)) {
      res.status(401).json({
        success: false,
        error: 'Invalid request signature',
        code: 'SIGNATURE_INVALID',
      });
      return;
    }

    next();
  };
}

// ============ Brute Force Protection ============

export function bruteForceProtection(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  const now = Date.now();

  let attempts = loginAttempts.get(ip);

  // Check if locked out
  if (attempts?.lockedUntil && now < attempts.lockedUntil) {
    const remainingMs = attempts.lockedUntil - now;
    res.status(429).json({
      success: false,
      error: 'Account temporarily locked due to too many failed attempts',
      retryAfter: Math.ceil(remainingMs / 1000),
      code: 'ACCOUNT_LOCKED',
    });
    return;
  }

  // Reset if lockout expired
  if (attempts?.lockedUntil && now >= attempts.lockedUntil) {
    loginAttempts.delete(ip);
  }

  next();
}

export function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  let attempts = loginAttempts.get(ip);

  if (!attempts) {
    attempts = { count: 0, lastAttempt: now };
    loginAttempts.set(ip, attempts);
  }

  attempts.count++;
  attempts.lastAttempt = now;

  // Lock if too many attempts
  if (attempts.count >= ADVANCED_SECURITY_CONFIG.maxLoginAttempts) {
    attempts.lockedUntil = now + ADVANCED_SECURITY_CONFIG.lockoutDuration;
    console.warn(`[SECURITY] IP ${ip} locked out after ${attempts.count} failed attempts`);
  }
}

export function recordSuccessfulAttempt(ip: string): void {
  loginAttempts.delete(ip);
}

// ============ Client Fingerprinting ============

export function generateFingerprint(req: Request): string {
  const parts: string[] = [];

  for (const header of ADVANCED_SECURITY_CONFIG.fingerprintHeaders) {
    const value = req.headers[header];
    if (typeof value === 'string') {
      parts.push(value);
    }
  }

  // Add IP
  parts.push(getClientIp(req));

  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').substring(0, 16);
}

export function fingerprintTracking(req: Request, res: Response, next: NextFunction): void {
  const fingerprint = generateFingerprint(req);
  const apiKey = req.headers['x-api-key'] as string;

  if (apiKey) {
    const storedFingerprint = clientFingerprints.get(apiKey);

    if (storedFingerprint && storedFingerprint !== fingerprint) {
      // Fingerprint changed - could be suspicious
      console.warn(`[SECURITY] Fingerprint changed for API key ending in ...${apiKey.slice(-4)}`);
      // You could add additional verification here
    }

    clientFingerprints.set(apiKey, fingerprint);
  }

  // Add fingerprint to request for logging
  (req as any).fingerprint = fingerprint;

  next();
}

// ============ SQL Injection Prevention ============

const SQL_INJECTION_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|CREATE|ALTER|TRUNCATE|EXEC|EXECUTE)\b)/i,
  /(--|\*|;|'|"|`|\\)/,
  /(\bOR\b|\bAND\b)\s+\d+\s*=\s*\d+/i,
  /(\bOR\b|\bAND\b)\s*['"]?\w+['"]?\s*=\s*['"]?\w+['"]?/i,
  /\b(WAITFOR|DELAY|BENCHMARK|SLEEP|LOAD_FILE|INTO\s+OUTFILE)\b/i,
];

export function sqlInjectionProtection(req: Request, res: Response, next: NextFunction): void {
  const checkValue = (value: unknown, path: string): boolean => {
    if (typeof value === 'string') {
      for (const pattern of SQL_INJECTION_PATTERNS) {
        if (pattern.test(value)) {
          console.warn(`[SECURITY] SQL injection attempt detected at ${path}: ${value.substring(0, 50)}`);
          return true;
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, val] of Object.entries(value)) {
        if (checkValue(val, `${path}.${key}`)) {
          return true;
        }
      }
    }
    return false;
  };

  // Check query parameters
  if (checkValue(req.query, 'query')) {
    res.status(400).json({
      success: false,
      error: 'Invalid query parameters',
      code: 'INJECTION_DETECTED',
    });
    return;
  }

  // Check body
  if (checkValue(req.body, 'body')) {
    res.status(400).json({
      success: false,
      error: 'Invalid request body',
      code: 'INJECTION_DETECTED',
    });
    return;
  }

  // Check URL parameters
  if (checkValue(req.params, 'params')) {
    res.status(400).json({
      success: false,
      error: 'Invalid URL parameters',
      code: 'INJECTION_DETECTED',
    });
    return;
  }

  next();
}

// ============ XSS Prevention ============

const XSS_PATTERNS = [
  /<script\b[^>]*>([\s\S]*?)<\/script>/gi,
  /<[^>]+\s+on\w+\s*=/gi,
  /javascript\s*:/gi,
  /data\s*:[^,]*base64/gi,
  /vbscript\s*:/gi,
  /expression\s*\(/gi,
];

export function xssProtection(req: Request, res: Response, next: NextFunction): void {
  const checkValue = (value: unknown, path: string): boolean => {
    if (typeof value === 'string') {
      for (const pattern of XSS_PATTERNS) {
        if (pattern.test(value)) {
          console.warn(`[SECURITY] XSS attempt detected at ${path}`);
          return true;
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, val] of Object.entries(value)) {
        if (checkValue(val, `${path}.${key}`)) {
          return true;
        }
      }
    }
    return false;
  };

  if (checkValue(req.query, 'query') || checkValue(req.body, 'body')) {
    res.status(400).json({
      success: false,
      error: 'Invalid input detected',
      code: 'XSS_DETECTED',
    });
    return;
  }

  next();
}

// ============ Path Traversal Prevention ============

export function pathTraversalProtection(req: Request, res: Response, next: NextFunction): void {
  const dangerousPatterns = [
    /\.\./,           // Parent directory
    /%2e%2e/i,        // URL encoded ..
    /%252e%252e/i,    // Double encoded ..
    /\\/,             // Backslash
    /\0/,             // Null byte
  ];

  const checkPath = (path: string): boolean => {
    for (const pattern of dangerousPatterns) {
      if (pattern.test(path)) {
        return true;
      }
    }
    return false;
  };

  if (checkPath(req.path) || checkPath(req.url)) {
    console.warn(`[SECURITY] Path traversal attempt: ${req.path}`);
    res.status(400).json({
      success: false,
      error: 'Invalid path',
      code: 'PATH_TRAVERSAL_DETECTED',
    });
    return;
  }

  next();
}

// ============ Content-Type Validation ============

export function contentTypeValidation(req: Request, res: Response, next: NextFunction): void {
  const contentType = req.headers['content-type'];

  // Only check POST/PUT/PATCH requests with body
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
    if (!contentType || !contentType.includes('application/json')) {
      res.status(415).json({
        success: false,
        error: 'Content-Type must be application/json',
        code: 'INVALID_CONTENT_TYPE',
      });
      return;
    }
  }

  next();
}

// ============ Secure Cookie Settings ============
// Note: This API is stateless and doesn't use cookies.
// If cookies are added in the future, use these secure defaults:
export const SECURE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: 3600000, // 1 hour
};

// ============ Helper Functions ============

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

// ============ Export Combined Advanced Security ============

export function applyAdvancedSecurity(req: Request, res: Response, next: NextFunction): void {
  // Chain all advanced security middleware
  pathTraversalProtection(req, res, () => {
    contentTypeValidation(req, res, () => {
      sqlInjectionProtection(req, res, () => {
        xssProtection(req, res, () => {
          replayProtection(req, res, () => {
            bruteForceProtection(req, res, () => {
              fingerprintTracking(req, res, next);
            });
          });
        });
      });
    });
  });
}
