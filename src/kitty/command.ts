// Parsing and encoding of kitty graphics command bodies: `k=v,k=v;payload`.

import type { KittyCommand } from '../types.ts'

/**
 * An error that maps onto a kitty response status: `code` is the errno-like
 * prefix (`EINVAL`, `ENOENT`, `EBADPNG`, `EFBIG`, ...), `message` the reason.
 */
export class KittyError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'KittyError'
    this.code = code
  }

  /** The status text of a response: `CODE:message`. */
  get status(): string {
    return `${this.code}:${this.message}`
  }
}

/**
 * Parses the body of a kitty graphics APC (the text between `G` and `ESC \`).
 * The control keys come before the first `;` as comma-separated `k=v` pairs
 * (values kept as strings); everything after it is the payload. A body with
 * no `;` has only keys and an empty payload. Empty pairs are skipped; a pair
 * without `=` gets an empty value; a repeated key keeps its last value.
 */
export function parseKittyCommand(body: string): KittyCommand {
  const semi = body.indexOf(';')
  const control = semi < 0 ? body : body.slice(0, semi)
  const payload = semi < 0 ? '' : body.slice(semi + 1)
  const keys: Record<string, string> = {}
  for (const pair of control.split(',')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    if (eq < 0) keys[pair] = ''
    else keys[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return { keys, payload }
}

/** The fields a response may echo back, in kitty's order. */
export type ResponseFields = { i?: number | undefined; I?: number | undefined; p?: number | undefined }

/**
 * Encodes a graphics response for the child's input:
 * `ESC _ G i=1,I=2,p=3;STATUS ESC \`. Absent or zero fields are left out.
 */
export function encodeResponse(fields: ResponseFields, status: string): string {
  const parts: string[] = []
  for (const key of ['i', 'I', 'p'] as const) {
    const value = fields[key]
    if (value !== undefined && value !== 0) parts.push(`${key}=${value}`)
  }
  return `\x1b_G${parts.join(',')};${status}\x1b\\`
}

/**
 * Reads an unsigned 32-bit integer key, `fallback` when absent or empty.
 * Throws `EINVAL` for anything that is not a plain decimal number in range.
 */
export function uintKey(keys: Record<string, string>, name: string, fallback = 0): number {
  const raw = keys[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d{1,10}$/.test(raw)) throw new KittyError('EINVAL', `invalid value for key ${name}: ${raw}`)
  const value = Number(raw)
  if (value > 0xffffffff) throw new KittyError('EINVAL', `value out of range for key ${name}: ${raw}`)
  return value
}
