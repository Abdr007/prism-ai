import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger as rootLogger } from '../lib/logger.js';

const log = rootLogger.child({ component: 'security' });

// ============ Security Configuration ============

const SECURITY_CONFIG = {
  // Rate limiting
  globalRateLimit: 1000,        // requests per minute globally
  ipRateLimit: 100,             // requests per minute per IP
  authRateLimit: 5,             // failed auth attempts per minute

  // Request limits
  maxBodySize: '1mb',
  maxUrlLength: 2048,
  maxHeaderSize: 8192,

  // Timeouts
  requestTimeout: 30000,        // 30 seconds

  // IP blocking
  blockDuration: 3600000,       // 1 hour in ms
  maxViolations: 10,            // violations before block

  // Suspicious patterns to block
  suspiciousPatterns: [
    /(\.\.|%2e%2e)/i,           // Path traversal
    /<script/i,                  // XSS attempts
    /javascript:/i,              // XSS attempts
    /on\w+\s*=/i,                // Event handler injection
    /(union|select|insert|update|delete|drop|;|--)/i,  // SQL injection
    /(\$|`|\{|\})/,              // Template/command injection
  ],
};

// ============ In-Memory Stores ============

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface ViolationEntry {
  count: number;
  lastViolation: number;
  blockedUntil?: number;
}

interface AuditEntry {
  timestamp: number;
  ip: string;
  method: string;
  path: string;
  userAgent?: string;
  apiKey?: string;
  statusCode?: number;
  responseTime?: number;
  blocked?: boolean;
  reason?: string;
}

const globalRateLimit: RateLimitEntry = { count: 0, resetAt: Date.now() + 60000 };
const ipRateLimits = new Map<string, RateLimitEntry>();
const authFailures = new Map<string, RateLimitEntry>();
const violations = new Map<string, ViolationEntry>();
const auditLog: AuditEntry[] = [];
const MAX_AUDIT_LOG = 10000;

// ============ Helper Functions ============

function getClientIp(req: Request): string {
  // Get real IP behind proxies
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function generateRequestId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeString(input: string): string {
  return input
    .replace(/[<>]/g, '')           // Remove angle brackets
    .replace(/javascript:/gi, '')    // Remove javascript: URIs
    .replace(/on\w+=/gi, '')         // Remove event handlers
    .trim();
}

function checkSuspiciousPatterns(input: string): { safe: boolean; pattern?: string } {
  for (const pattern of SECURITY_CONFIG.suspiciousPatterns) {
    if (pattern.test(input)) {
      return { safe: false, pattern: pattern.source };
    }
  }
  return { safe: true };
}

// ============ Security Headers Middleware ============

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // Generate request ID for tracing
  const requestId = generateRequestId();
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-ID', requestId);

  // Security headers (similar to helmet)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Remove fingerprinting headers
  res.removeHeader('X-Powered-By');

  next();
}

// ============ Global Rate Limiting ============

export function globalRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();

  // Reset if window expired
  if (now > globalRateLimit.resetAt) {
    globalRateLimit.count = 0;
    globalRateLimit.resetAt = now + 60000;
  }

  if (globalRateLimit.count >= SECURITY_CONFIG.globalRateLimit) {
    res.status(503).json({
      success: false,
      error: 'Service temporarily unavailable due to high load',
      retryAfter: Math.ceil((globalRateLimit.resetAt - now) / 1000),
    });
    return;
  }

  globalRateLimit.count++;
  next();
}

// ============ IP-based Rate Limiting ============

export function ipRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  const now = Date.now();

  // Check if IP is blocked
  const violation = violations.get(ip);
  if (violation?.blockedUntil && now < violation.blockedUntil) {
    const remainingMs = violation.blockedUntil - now;
    res.status(403).json({
      success: false,
      error: 'Your IP has been temporarily blocked due to suspicious activity',
      blockedFor: Math.ceil(remainingMs / 1000),
    });
    logAudit(req, res, true, 'IP blocked');
    return;
  }

  // Rate limit check
  let rateData = ipRateLimits.get(ip);
  if (!rateData || now > rateData.resetAt) {
    rateData = { count: 0, resetAt: now + 60000 };
    ipRateLimits.set(ip, rateData);
  }

  if (rateData.count >= SECURITY_CONFIG.ipRateLimit) {
    recordViolation(ip, 'Rate limit exceeded');
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil((rateData.resetAt - now) / 1000),
    });
    return;
  }

  rateData.count++;

  // Add rate limit headers
  res.setHeader('X-RateLimit-Limit', SECURITY_CONFIG.ipRateLimit.toString());
  res.setHeader('X-RateLimit-Remaining', (SECURITY_CONFIG.ipRateLimit - rateData.count).toString());
  res.setHeader('X-RateLimit-Reset', Math.ceil(rateData.resetAt / 1000).toString());

  next();
}

// ============ Request Validation ============

export function requestValidator(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);

  // Check URL length
  if (req.url.length > SECURITY_CONFIG.maxUrlLength) {
    recordViolation(ip, 'URL too long');
    res.status(414).json({
      success: false,
      error: 'URI too long',
    });
    return;
  }

  // Check for suspicious patterns in URL
  const urlCheck = checkSuspiciousPatterns(req.url);
  if (!urlCheck.safe) {
    recordViolation(ip, `Suspicious URL pattern: ${urlCheck.pattern}`);
    res.status(400).json({
      success: false,
      error: 'Invalid request',
    });
    return;
  }

  // Check query parameters
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') {
      const queryCheck = checkSuspiciousPatterns(value);
      if (!queryCheck.safe) {
        recordViolation(ip, `Suspicious query param: ${key}`);
        res.status(400).json({
          success: false,
          error: 'Invalid query parameter',
        });
        return;
      }
    }
  }

  next();
}

// ============ Body Sanitization ============

export function bodySanitizer(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);

  if (req.body && typeof req.body === 'object') {
    try {
      sanitizeObject(req.body, ip);
    } catch (error) {
      res.status(400).json({
        success: false,
        error: 'Invalid request body',
      });
      return;
    }
  }

  next();
}

function sanitizeObject(obj: Record<string, unknown>, ip: string): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (typeof value === 'string') {
      // Check for suspicious patterns
      const check = checkSuspiciousPatterns(value);
      if (!check.safe) {
        recordViolation(ip, `Suspicious body content: ${key}`);
        throw new Error('Suspicious content detected');
      }

      // Sanitize the string
      obj[key] = sanitizeString(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitizeObject(value as Record<string, unknown>, ip);
    }
  }
}

// ============ Auth Failure Tracking ============

export function trackAuthFailure(ip: string): boolean {
  const now = Date.now();

  let failures = authFailures.get(ip);
  if (!failures || now > failures.resetAt) {
    failures = { count: 0, resetAt: now + 60000 };
    authFailures.set(ip, failures);
  }

  failures.count++;

  if (failures.count >= SECURITY_CONFIG.authRateLimit) {
    recordViolation(ip, 'Too many auth failures');
    return true; // Should be blocked
  }

  return false;
}

// ============ Violation Recording ============

function recordViolation(ip: string, reason: string): void {
  const now = Date.now();

  let violation = violations.get(ip);
  if (!violation) {
    violation = { count: 0, lastViolation: now };
    violations.set(ip, violation);
  }

  violation.count++;
  violation.lastViolation = now;

  // Block if too many violations
  if (violation.count >= SECURITY_CONFIG.maxViolations) {
    violation.blockedUntil = now + SECURITY_CONFIG.blockDuration;
    log.warn({ ip, blockDurationS: SECURITY_CONFIG.blockDuration / 1000, reason }, 'IP blocked');
  }
}

// ============ Audit Logging ============

function logAudit(req: Request, res: Response, blocked = false, reason?: string): void {
  const entry: AuditEntry = {
    timestamp: Date.now(),
    ip: getClientIp(req),
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
    apiKey: req.headers['x-api-key'] ? '****' + String(req.headers['x-api-key']).slice(-4) : undefined,
    blocked,
    reason,
  };

  auditLog.push(entry);

  // Trim old entries
  if (auditLog.length > MAX_AUDIT_LOG) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT_LOG);
  }
}

export function auditLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  // Log on response finish
  res.on('finish', () => {
    const entry: AuditEntry = {
      timestamp: startTime,
      ip: getClientIp(req),
      method: req.method,
      path: req.path,
      userAgent: req.headers['user-agent'],
      apiKey: req.headers['x-api-key'] ? '****' + String(req.headers['x-api-key']).slice(-4) : undefined,
      statusCode: res.statusCode,
      responseTime: Date.now() - startTime,
    };

    auditLog.push(entry);

    // Log suspicious responses
    if (res.statusCode >= 400) {
      log.info({ ip: entry.ip, method: entry.method, path: entry.path, statusCode: entry.statusCode, responseTimeMs: entry.responseTime }, 'Audit log entry');
    }

    // Trim old entries
    if (auditLog.length > MAX_AUDIT_LOG) {
      auditLog.splice(0, auditLog.length - MAX_AUDIT_LOG);
    }
  });

  next();
}

// ============ Request Timeout ============

export function requestTimeout(req: Request, res: Response, next: NextFunction): void {
  req.setTimeout(SECURITY_CONFIG.requestTimeout, () => {
    res.status(408).json({
      success: false,
      error: 'Request timeout',
    });
  });

  next();
}

// ============ Admin Security Endpoints ============

export function getSecurityStats(): {
  blockedIps: number;
  activeViolations: number;
  recentAuditCount: number;
  globalRequestsPerMinute: number;
} {
  const now = Date.now();

  return {
    blockedIps: Array.from(violations.values()).filter(v => v.blockedUntil && v.blockedUntil > now).length,
    activeViolations: violations.size,
    recentAuditCount: auditLog.filter(a => a.timestamp > now - 3600000).length,
    globalRequestsPerMinute: globalRateLimit.count,
  };
}

export function getRecentAuditLog(limit = 100): AuditEntry[] {
  return auditLog.slice(-limit);
}

export function unblockIp(ip: string): boolean {
  const violation = violations.get(ip);
  if (violation) {
    violation.blockedUntil = undefined;
    violation.count = 0;
    return true;
  }
  return false;
}

// ============ Combined Security Middleware ============

export function applySecurity(req: Request, res: Response, next: NextFunction): void {
  // Chain all security middleware
  securityHeaders(req, res, () => {
    globalRateLimiter(req, res, () => {
      ipRateLimiter(req, res, () => {
        requestValidator(req, res, () => {
          requestTimeout(req, res, () => {
            auditLogger(req, res, next);
          });
        });
      });
    });
  });
}
