import { translateKeys } from '../keys.js'

export async function runCommand(opts: { target: string; keys: string[] }, client: any) {
  const data = translateKeys(opts.keys)
  return client.post(`/api/panes/${encodeURIComponent(opts.target)}/send-keys`, { data })
}
