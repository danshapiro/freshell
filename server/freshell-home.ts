// Temporary compatibility boundary.  Legacy Node-server modules continue to
// import this path until the server tree is removed; the neutral owner is the
// shared module so clients and the Rust migration use one contract.
export {
  getFreshellConfigDir,
  getFreshellHomeDir,
} from '../shared/freshell-home.js'
export type { FreshellEnvironment } from '../shared/freshell-home.js'
