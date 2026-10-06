// 10X RPC — "RPC DEVICE / PLATFORM" selector (reference design: flat list, purple-text selected state)
'use client'
import { ChevronDown } from 'lucide-react'
import { RPC_PLATFORM_OPTIONS, rpcPlatformLabel } from '@/lib/constants'

export function RpcPlatformSelect({
  value,
  onChange,
  open,
  onToggle,
  onClose,
}: {
  value: string
  onChange: (v: string) => void
  open: boolean
  onToggle: () => void
  onClose: () => void
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="w-full h-14 bg-[#111116] border border-white/10 hover:border-white/20 focus:border-purple-500/50 rounded-2xl pl-5 pr-4 text-lg text-white flex items-center justify-between cursor-pointer transition-colors"
      >
        <span>{rpcPlatformLabel(value)}</span>
        <ChevronDown className={`w-5 h-5 text-white/60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-full bg-[#1c1927]/95 backdrop-blur-xl border border-white/10 rounded-2xl p-2 shadow-2xl z-50 space-y-1">
          {RPC_PLATFORM_OPTIONS.map(opt => {
            const isSelected = value === opt.value || (opt.value === 'ps4' && value === 'ps5')
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); onClose() }}
                className={`w-full flex items-center px-4 py-3.5 rounded-xl text-lg transition-colors text-left ${
                  isSelected
                    ? 'bg-purple-500/15 text-purple-300 font-medium'
                    : 'text-white/85 hover:text-white hover:bg-white/5'
                }`}
              >
                <span>{opt.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
