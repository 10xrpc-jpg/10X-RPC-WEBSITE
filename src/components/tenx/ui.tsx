// 10X RPC — shared UI atoms
'use client'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ReactNode } from 'react'

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('glass-card p-5 sm:p-6 shadow-2xl', className)}>
      {children}
    </div>
  )
}

export function SectionTitle({ icon, children, right }: { icon?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-2">
        {icon && <span className="text-purple-400">{icon}</span>}
        {children}
      </h2>
      {right}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-wider text-purple-400 font-semibold">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Input
      {...props}
      className={cn(
        'bg-[#13141a] border-white/8 text-white placeholder:text-muted-foreground/60',
        'focus-visible:ring-purple-500/50 focus-visible:border-purple-500/50',
        props.className
      )}
    />
  )
}

export function PurpleSwitch({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (v: boolean) => void }) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onCheckedChange}
      className="data-[state=checked]:bg-purple-500 data-[state=unchecked]:bg-white/10"
    />
  )
}

export function PillSelect<T extends string>({
  value, onValueChange, options, placeholder,
}: {
  value: T
  onValueChange: (v: T) => void
  options: { value: T; label: string }[]
  placeholder?: string
}) {
  return (
    <Select value={value} onValueChange={(v) => onValueChange(v as T)}>
      <SelectTrigger className="bg-[#13141a] border-white/8 text-white focus:ring-purple-500/40">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="bg-[#13141a] border-white/10 text-white">
        {options.map(o => (
          <SelectItem key={o.value} value={o.value} className="text-white focus:bg-purple-500/20">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function PrimaryButton({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        'purple-gradient text-white font-semibold rounded-xl px-4 py-2.5 shadow-lg shadow-purple-900/30',
        'hover:opacity-90 active:scale-[0.98] transition-all',
        className
      )}
    >
      {children}
    </button>
  )
}

export function GhostButton({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        'bg-white/5 border border-white/8 text-white font-medium rounded-xl px-4 py-2.5',
        'hover:bg-white/10 active:scale-[0.98] transition-all',
        className
      )}
    >
      {children}
    </button>
  )
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-sm text-white/80 hover:bg-white/10 transition-colors"
    >
      <span>←</span> Back
    </button>
  )
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full',
      className
    )}>
      {children}
    </span>
  )
}
