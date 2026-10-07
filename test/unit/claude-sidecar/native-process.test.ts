import { expect, it } from 'vitest'
import { spawnObservedNative } from '../../../crates/freshell-claude-sidecar/native-process.mjs'

it('correlates actual successful native stdin writes without counting local callback resolution as dispatch', async () => {
  const writes: any[] = []
  const child = spawnObservedNative({ command: process.execPath, args: ['-e', "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0))"], env: process.env }, { onControlWrite: (frame: any, error: any) => writes.push({ frame, error }) })
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()) })
  const frame = { type: 'control_response', response: { subtype: 'success', request_id: 'actual-native-request', response: { behavior: 'deny', message: 'Denied' } } }
  const bytes = JSON.stringify(frame) + '\n'
  child.stdin.write(bytes.slice(0, 20))
  expect(writes).toEqual([])
  await new Promise<void>((resolve, reject) => child.stdin.write(bytes.slice(20), (error: any) => error ? reject(error) : resolve()))
  child.stdin.end()
  await exited
  expect(writes).toEqual([{ frame, error: undefined }])
})
