import { useState } from 'react'
import { X, Mail, Chrome, Twitter, Loader2, Check, AlertCircle } from 'lucide-react'

interface AuthModalProps {
  isOpen: boolean
  onClose: () => void
  onLogin: (user: User) => void
}

export interface User {
  id: string
  email?: string
  walletAddress?: string
  provider: 'google' | 'twitter' | 'wallet' | 'email'
  displayName?: string
  avatar?: string
  isPremium: boolean
  createdAt: Date
}

type AuthStep = 'choose' | 'email' | 'connecting' | 'success' | 'error'

// Wallet types
const WALLETS = [
  { id: 'metamask', name: 'MetaMask', icon: '🦊', type: 'evm' },
  { id: 'phantom', name: 'Phantom', icon: '👻', type: 'solana' },
  { id: 'coinbase', name: 'Coinbase Wallet', icon: '🔵', type: 'evm' },
  { id: 'walletconnect', name: 'WalletConnect', icon: '🔗', type: 'evm' },
]

export function AuthModal({ isOpen, onClose, onLogin }: AuthModalProps) {
  const [step, setStep] = useState<AuthStep>('choose')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedWallet, setSelectedWallet] = useState('')

  if (!isOpen) return null

  const handleGoogleLogin = async () => {
    setLoading(true)
    setError('')
    setStep('connecting')

    try {
      // In production, this would redirect to Google OAuth
      // For demo, we simulate a successful login
      await new Promise(resolve => setTimeout(resolve, 1500))

      const user: User = {
        id: 'google_' + Date.now(),
        email: 'user@gmail.com',
        provider: 'google',
        displayName: 'Google User',
        isPremium: false,
        createdAt: new Date(),
      }

      // Notify backend for Telegram alert
      await notifyLogin(user)

      setStep('success')
      setTimeout(() => {
        onLogin(user)
        onClose()
      }, 1000)
    } catch (err) {
      setError('Failed to connect with Google')
      setStep('error')
    } finally {
      setLoading(false)
    }
  }

  const handleTwitterLogin = async () => {
    setLoading(true)
    setError('')
    setStep('connecting')

    try {
      // In production, this would redirect to Twitter OAuth
      await new Promise(resolve => setTimeout(resolve, 1500))

      const user: User = {
        id: 'twitter_' + Date.now(),
        provider: 'twitter',
        displayName: '@user',
        isPremium: false,
        createdAt: new Date(),
      }

      await notifyLogin(user)

      setStep('success')
      setTimeout(() => {
        onLogin(user)
        onClose()
      }, 1000)
    } catch (err) {
      setError('Failed to connect with X')
      setStep('error')
    } finally {
      setLoading(false)
    }
  }

  const handleWalletConnect = async (walletId: string) => {
    setSelectedWallet(walletId)
    setLoading(true)
    setError('')
    setStep('connecting')

    try {
      let address = ''

      // Check for wallet providers
      if (walletId === 'metamask') {
        if (typeof window !== 'undefined' && (window as any).ethereum?.isMetaMask) {
          const accounts = await (window as any).ethereum.request({
            method: 'eth_requestAccounts'
          })
          address = accounts[0]
        } else {
          throw new Error('MetaMask not installed')
        }
      } else if (walletId === 'phantom') {
        if (typeof window !== 'undefined' && (window as any).solana?.isPhantom) {
          const resp = await (window as any).solana.connect()
          address = resp.publicKey.toString()
        } else {
          throw new Error('Phantom not installed')
        }
      } else {
        // For other wallets, simulate connection
        await new Promise(resolve => setTimeout(resolve, 1500))
        address = '0x' + Math.random().toString(16).slice(2, 42)
      }

      const user: User = {
        id: 'wallet_' + Date.now(),
        walletAddress: address,
        provider: 'wallet',
        displayName: address.slice(0, 6) + '...' + address.slice(-4),
        isPremium: false,
        createdAt: new Date(),
      }

      await notifyLogin(user)

      setStep('success')
      setTimeout(() => {
        onLogin(user)
        onClose()
      }, 1000)
    } catch (err: any) {
      setError(err.message || 'Failed to connect wallet')
      setStep('error')
    } finally {
      setLoading(false)
    }
  }

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.includes('@')) {
      setError('Please enter a valid email')
      return
    }

    setLoading(true)
    setError('')
    setStep('connecting')

    try {
      // In production, send magic link email
      await new Promise(resolve => setTimeout(resolve, 1500))

      const user: User = {
        id: 'email_' + Date.now(),
        email,
        provider: 'email',
        displayName: email.split('@')[0],
        isPremium: false,
        createdAt: new Date(),
      }

      await notifyLogin(user)

      setStep('success')
      setTimeout(() => {
        onLogin(user)
        onClose()
      }, 1000)
    } catch (err) {
      setError('Failed to send login link')
      setStep('error')
    } finally {
      setLoading(false)
    }
  }

  // Notify backend about login (for Telegram alert)
  const notifyLogin = async (user: User) => {
    try {
      await fetch('http://localhost:3000/api/v1/auth/login-notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          provider: user.provider,
          displayName: user.displayName,
          email: user.email,
          walletAddress: user.walletAddress,
          timestamp: new Date().toISOString(),
        }),
      })
    } catch {
      // Silent fail - notification is not critical
    }
  }

  const resetState = () => {
    setStep('choose')
    setError('')
    setEmail('')
    setSelectedWallet('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-[#0d0e14] rounded-2xl border border-white/10 w-full max-w-md mx-4 overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="p-6 border-b border-white/5">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold">
              {step === 'choose' && 'Connect to Prism'}
              {step === 'email' && 'Login with Email'}
              {step === 'connecting' && 'Connecting...'}
              {step === 'success' && 'Connected!'}
              {step === 'error' && 'Connection Failed'}
            </h2>
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-sm text-slate-400 mt-1">
            {step === 'choose' && 'Choose how you want to connect'}
            {step === 'email' && 'We\'ll send you a magic link'}
            {step === 'connecting' && `Connecting with ${selectedWallet || 'service'}...`}
            {step === 'success' && 'You\'re all set!'}
            {step === 'error' && 'Please try again'}
          </p>
        </div>

        {/* Content */}
        <div className="p-6">
          {step === 'choose' && (
            <div className="space-y-4">
              {/* Social Logins */}
              <div className="space-y-2">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-3">Social Login</p>
                <button
                  onClick={handleGoogleLogin}
                  className="w-full flex items-center gap-3 p-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-all"
                >
                  <Chrome className="w-5 h-5 text-blue-400" />
                  <span className="font-medium">Continue with Google</span>
                </button>
                <button
                  onClick={handleTwitterLogin}
                  className="w-full flex items-center gap-3 p-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-all"
                >
                  <Twitter className="w-5 h-5 text-sky-400" />
                  <span className="font-medium">Continue with X</span>
                </button>
              </div>

              {/* Divider */}
              <div className="flex items-center gap-4 py-2">
                <div className="flex-1 h-px bg-white/10" />
                <span className="text-xs text-slate-500">or</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>

              {/* Wallet Connections */}
              <div className="space-y-2">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-3">Connect Wallet</p>
                <div className="grid grid-cols-2 gap-2">
                  {WALLETS.map(wallet => (
                    <button
                      key={wallet.id}
                      onClick={() => handleWalletConnect(wallet.id)}
                      className="flex flex-col items-center gap-2 p-4 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-all"
                    >
                      <span className="text-2xl">{wallet.icon}</span>
                      <span className="text-sm font-medium">{wallet.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Email Option */}
              <button
                onClick={() => setStep('email')}
                className="w-full flex items-center justify-center gap-2 p-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-all mt-4"
              >
                <Mail className="w-4 h-4" />
                <span className="text-sm">Continue with Email</span>
              </button>
            </div>
          )}

          {step === 'email' && (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="Enter your email"
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/50"
                autoFocus
              />
              {error && (
                <p className="text-sm text-red-400">{error}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={resetState}
                  className="flex-1 py-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 py-3 rounded-xl bg-blue-500 hover:bg-blue-600 transition-colors font-medium disabled:opacity-50"
                >
                  Send Link
                </button>
              </div>
            </form>
          )}

          {step === 'connecting' && (
            <div className="py-8 flex flex-col items-center gap-4">
              <Loader2 className="w-12 h-12 text-blue-400 animate-spin" />
              <p className="text-slate-400">Please confirm in your wallet...</p>
            </div>
          )}

          {step === 'success' && (
            <div className="py-8 flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center">
                <Check className="w-8 h-8 text-green-500" />
              </div>
              <p className="text-green-400 font-medium">Successfully connected!</p>
            </div>
          )}

          {step === 'error' && (
            <div className="py-8 flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
                <AlertCircle className="w-8 h-8 text-red-500" />
              </div>
              <p className="text-red-400">{error}</p>
              <button
                onClick={resetState}
                className="px-6 py-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
              >
                Try Again
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/5 text-center">
          <p className="text-xs text-slate-500">
            By connecting, you agree to our Terms of Service
          </p>
        </div>
      </div>
    </div>
  )
}

export default AuthModal
