// The child pty wrapper's exit-code handling.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { IPty } from 'node-pty'
import { settleExitCode } from '../src/host/pty.ts'

/** A stand-in for node-pty's IPty with the agent field settleExitCode reads. */
function fakePty(agent: { exitCode?: number }): IPty {
  return { _agent: agent } as unknown as IPty
}

describe('settleExitCode', () => {
  it('returns a reported code at once', async () => {
    const agent = { exitCode: undefined as number | undefined }
    assert.equal(await settleExitCode(fakePty(agent), 42, 50), 42)
    assert.equal(await settleExitCode(fakePty(agent), 0, 50), 0)
  })

  it('waits for the code the native side reports after the exit event', async () => {
    const agent = { exitCode: undefined as number | undefined }
    setTimeout(() => (agent.exitCode = 42), 40)
    assert.equal(await settleExitCode(fakePty(agent), undefined, 2000), 42)
  })

  it('falls back to 0 when no code ever arrives', async () => {
    const started = Date.now()
    assert.equal(await settleExitCode(fakePty({}), undefined, 60), 0)
    assert.ok(Date.now() - started >= 50)
    // No agent at all (another node-pty build): the same fallback.
    assert.equal(await settleExitCode({} as unknown as IPty, undefined, 20), 0)
  })
})
