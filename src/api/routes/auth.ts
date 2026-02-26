import { Router, Request, Response } from 'express';
import axios from 'axios';

const router = Router();

// Telegram configuration (set via env vars)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

interface LoginNotification {
  userId: string;
  provider: 'google' | 'twitter' | 'wallet' | 'email';
  displayName?: string;
  email?: string;
  walletAddress?: string;
  timestamp: string;
}

// Send Telegram notification
async function sendTelegramNotification(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Auth] Telegram not configured, skipping notification');
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
    });
    console.log('[Auth] Telegram notification sent');
  } catch (error) {
    console.error('[Auth] Failed to send Telegram notification:', error);
  }
}

// Format login notification message
function formatLoginMessage(data: LoginNotification): string {
  const providerEmoji = {
    google: '🔵 Google',
    twitter: '🐦 X (Twitter)',
    wallet: '🔗 Wallet',
    email: '📧 Email',
  };

  const time = new Date(data.timestamp).toLocaleString();

  let message = `🔔 <b>New Login on Prism AI</b>\n\n`;
  message += `📱 <b>Provider:</b> ${providerEmoji[data.provider] || data.provider}\n`;

  if (data.displayName) {
    message += `👤 <b>User:</b> ${data.displayName}\n`;
  }
  if (data.email) {
    message += `📧 <b>Email:</b> ${data.email}\n`;
  }
  if (data.walletAddress) {
    const shortAddress = data.walletAddress.slice(0, 10) + '...' + data.walletAddress.slice(-8);
    message += `💳 <b>Wallet:</b> <code>${shortAddress}</code>\n`;
  }

  message += `⏰ <b>Time:</b> ${time}\n`;
  message += `🆔 <b>ID:</b> <code>${data.userId}</code>`;

  return message;
}

// POST /api/v1/auth/login-notify
// Called by frontend when user logs in
router.post('/login-notify', async (req: Request, res: Response) => {
  try {
    const data = req.body as LoginNotification;

    // Validate required fields
    if (!data.userId || !data.provider || !data.timestamp) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, provider, timestamp',
      });
    }

    // Validate provider
    const validProviders = ['google', 'twitter', 'wallet', 'email'];
    if (!validProviders.includes(data.provider)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid provider',
      });
    }

    // Log the login
    console.log(`[Auth] New login: ${data.provider} - ${data.displayName || data.userId}`);

    // Send Telegram notification
    const message = formatLoginMessage(data);
    await sendTelegramNotification(message);

    // In a real app, you would:
    // 1. Store user in database
    // 2. Generate JWT token
    // 3. Return session info

    res.json({
      success: true,
      message: 'Login notification sent',
    });
  } catch (error) {
    console.error('[Auth] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// GET /api/v1/auth/status
// Check if user is authenticated (for future use)
router.get('/status', (req: Request, res: Response) => {
  // In a real app, verify JWT token here
  res.json({
    success: true,
    authenticated: false,
    user: null,
  });
});

export default router;
