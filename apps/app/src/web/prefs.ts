import { useState } from 'preact/hooks'
import { api } from './api.ts'

/**
 * A person's view choices — filters, layouts, the period, theme, language — kept on the server
 * with their account, so they survive a refresh, signing out and another device. Changes are
 * sent in one batch shortly after the last one.
 */
let store: Record<string, unknown> = {}
let pending: Record<string, unknown> = {}
let timer: ReturnType<typeof setTimeout> | undefined

export const loadPrefs = (p: Record<string, unknown> | undefined) => {
  store = { ...(p ?? {}) }
}

export const getPref = <T>(key: string, fallback: T): T =>
  key in store ? (store[key] as T) : fallback

export async function flushPrefs() {
  clearTimeout(timer)
  if (!Object.keys(pending).length) return
  const prefs = pending
  pending = {}
  await api.patch('/api/auth/me', { prefs }).catch(() => {
    pending = { ...prefs, ...pending }
  })
}

export function setPref(key: string, value: unknown) {
  store[key] = value
  pending[key] = value
  clearTimeout(timer)
  timer = setTimeout(() => void flushPrefs(), 600)
}

/** useState, kept with the account. */
export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => getPref(key, fallback))
  return [
    v,
    (next: T) => {
      setV(next)
      setPref(key, next)
    },
  ]
}
