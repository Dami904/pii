/**
 * src/components/UnlockScreen.tsx
 * EIP-712 sign-to-unlock screen. Derives keys, optionally registers in PiiKeyRegistry.
 */

import { useState }                        from 'react'
import { useAccount, useSignTypedData, useWriteContract, usePublicClient } from 'wagmi'
import { toast }                           from 'sonner'
import { Copy, Check, Shield, UserPlus }   from 'lucide-react'
import { deriveKeys }                      from '@sdk/keys'
import { deriveViewingKeys, encodePiiAddress } from '@sdk/memo'
import { usePii }                          from '../contexts/PiiContext.js'
import { REGISTRY_ADDRESS, REGISTRY_ABI, CHAIN_ID } from '../lib/pii.js'

export default function UnlockScreen() {
  const { address, chain }           = useAccount()
  const { signTypedDataAsync }       = useSignTypedData()
  const { writeContractAsync }       = useWriteContract()
  const pub                          = usePublicClient()
  const { keys, viewKeys, setKeys }  = usePii()

  const [unlocking, setUnlocking]    = useState(false)
  const [registering, setRegistering] = useState(false)
  const [copied, setCopied]          = useState(false)
  const [registered, setRegistered]  = useState(false)

  const chainId = chain?.id ?? CHAIN_ID

  const piiAddr = (keys && viewKeys)
    ? encodePiiAddress(keys.ownerKey, viewKeys.encPub)
    : null

  async function handleUnlock() {
    if (!address) { toast.error('Connect your wallet first'); return }
    setUnlocking(true)
    try {
      const k  = await deriveKeys(signTypedDataAsync, chainId)
      const vk = deriveViewingKeys(k.sk)
      setKeys(k, vk)
      toast.success('Pii wallet unlocked')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Unlock failed')
    } finally {
      setUnlocking(false)
    }
  }

  async function handleRegister() {
    if (!keys || !viewKeys || !pub) return
    setRegistering(true)
    try {
      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'register',
        args: [keys.ownerKey, `0x${Buffer.from(viewKeys.encPub).toString('hex')}`],
      })
      await pub.waitForTransactionReceipt({ hash })
      setRegistered(true)
      toast.success('Registered in PiiKeyRegistry')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Registration failed')
    } finally {
      setRegistering(false)
    }
  }

  function handleCopy() {
    if (!piiAddr) return
    void navigator.clipboard.writeText(piiAddr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!address) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 px-4">
        <div className="w-14 h-14 rounded-2xl bg-[var(--accent)] flex items-center justify-center">
          <Shield className="w-7 h-7 text-white" />
        </div>
        <div className="text-center">
          <h1 className="font-display text-2xl font-700 text-[var(--ink)] tracking-tight">Pii</h1>
          <p className="text-[var(--muted)] text-sm mt-1">Private payments on Arc Testnet</p>
        </div>
        <p className="text-[var(--subtle)] text-sm text-center max-w-xs">
          Connect your wallet to get started.
        </p>
      </div>
    )
  }

  if (!keys) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 px-4">
        <div className="w-14 h-14 rounded-2xl bg-[var(--accent)] flex items-center justify-center">
          <Shield className="w-7 h-7 text-white" />
        </div>
        <div className="text-center">
          <h1 className="font-display text-2xl font-700 text-[var(--ink)] tracking-tight">Unlock Pii</h1>
          <p className="text-[var(--muted)] text-sm mt-1 max-w-xs text-center">
            Sign a message to derive your private keys.<br />
            Keys never leave your browser.
          </p>
        </div>
        <button
          onClick={() => { void handleUnlock() }}
          disabled={unlocking}
          className="w-full max-w-xs h-12 rounded-xl bg-[var(--accent)] text-white font-semibold text-sm
                     hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          {unlocking ? 'Signing…' : 'Sign to unlock'}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      {/* Pii address card */}
      <div className="rounded-2xl bg-[var(--surface-strong)] border border-[var(--border)]
                      backdrop-blur-sm p-5 flex flex-col gap-3">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">
          Your Pii address
        </p>
        <div className="flex items-start gap-2">
          <p className="font-mono text-xs text-[var(--ink-2)] break-all leading-relaxed flex-1">
            {piiAddr}
          </p>
          <button
            onClick={handleCopy}
            className="p-2 rounded-lg hover:bg-[var(--surface-muted)] transition-colors flex-shrink-0"
          >
            {copied ? <Check className="w-4 h-4 text-[var(--success)]" /> : <Copy className="w-4 h-4 text-[var(--subtle)]" />}
          </button>
        </div>
        <p className="text-xs text-[var(--subtle)]">
          Share this address to receive private payments.
        </p>
      </div>

      {/* Register */}
      <button
        onClick={() => { void handleRegister() }}
        disabled={registering || registered}
        className="flex items-center justify-center gap-2 h-11 rounded-xl border border-[var(--border)]
                   bg-[var(--surface)] text-[var(--ink-2)] text-sm font-medium
                   hover:bg-[var(--surface-strong)] disabled:opacity-50 transition-colors"
      >
        <UserPlus className="w-4 h-4" />
        {registered ? 'Registered' : registering ? 'Registering…' : 'Register address on-chain'}
      </button>
      <p className="text-xs text-[var(--subtle)] text-center">
        Registration makes your address discoverable to senders.
      </p>
    </div>
  )
}
