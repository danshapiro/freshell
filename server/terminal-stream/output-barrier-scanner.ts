export type TerminalOutputBarrierReason =
  | 'control'
  | 'osc52'
  | 'request_mode'
  | 'turn_complete'
  | 'startup_probe'

export type TerminalOutputScannerMode = 'ground' | 'esc' | 'csi' | 'osc' | 'dcs' | 'apc'

export type TerminalOutputScannerState = {
  mode: TerminalOutputScannerMode
}

export type TerminalOutputBarrierClassification =
  | {
      barrier: false
      ground: boolean
      stateBefore: TerminalOutputScannerState
      stateAfter: TerminalOutputScannerState
    }
  | {
      barrier: true
      reason: TerminalOutputBarrierReason
      ground: boolean
      stateBefore: TerminalOutputScannerState
      stateAfter: TerminalOutputScannerState
    }

export type TerminalOutputBarrierScanner = {
  scan: (data: string) => TerminalOutputBarrierClassification
  isGround: () => boolean
}

const ESC = 0x1b
const BEL = 0x07
const CSI = 0x9b
const OSC = 0x9d
const DCS = 0x90
const SOS = 0x98
const ST = 0x9c
const PM = 0x9e
const APC = 0x9f
const REPLACEMENT_CHARACTER = 0xfffd
const CSI_PAYLOAD_SUFFIX_LIMIT = 64

const REASON_PRIORITY: Record<TerminalOutputBarrierReason, number> = {
  control: 1,
  turn_complete: 2,
  startup_probe: 3,
  request_mode: 4,
  osc52: 5,
}

function snapshot(mode: TerminalOutputScannerMode): TerminalOutputScannerState {
  return { mode }
}

function defaultReasonForMode(mode: TerminalOutputScannerMode): TerminalOutputBarrierReason {
  return mode === 'osc' ? 'osc52' : 'control'
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e
}

function isEscIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f
}

function isEscFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e
}

function isTransparentGroundControl(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
}

function isGroundControlBarrier(codePoint: number): boolean {
  if (isTransparentGroundControl(codePoint)) return false
  return codePoint < 0x20 || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)
}

function classifyCsiFinal(payload: string, finalChar: string): TerminalOutputBarrierReason {
  const normalizedPayload = payload.replace(/[ -/]/gu, '')
  if (finalChar === 'n' && normalizedPayload.endsWith('6')) {
    return 'request_mode'
  }
  if (finalChar === 'c') {
    return 'startup_probe'
  }
  return 'control'
}

export function createTerminalOutputBarrierScanner(): TerminalOutputBarrierScanner {
  let mode: TerminalOutputScannerMode = 'ground'
  let csiPayloadSuffix = ''
  let stringEscPending = false

  const enterCsi = () => {
    mode = 'csi'
    csiPayloadSuffix = ''
    stringEscPending = false
  }

  const enterStringMode = (nextMode: 'osc' | 'dcs' | 'apc') => {
    mode = nextMode
    csiPayloadSuffix = ''
    stringEscPending = false
  }

  const enterEsc = () => {
    mode = 'esc'
    csiPayloadSuffix = ''
    stringEscPending = false
  }

  const enterGround = () => {
    mode = 'ground'
    csiPayloadSuffix = ''
    stringEscPending = false
  }

  const recordReason = (
    current: TerminalOutputBarrierReason | undefined,
    reason: TerminalOutputBarrierReason,
  ): TerminalOutputBarrierReason => {
    if (!current || REASON_PRIORITY[reason] > REASON_PRIORITY[current]) {
      return reason
    }
    return current
  }

  const scanner: TerminalOutputBarrierScanner = {
    scan(data: string): TerminalOutputBarrierClassification {
      const stateBefore = snapshot(mode)
      let barrierReason: TerminalOutputBarrierReason | undefined

      if (mode !== 'ground') {
        barrierReason = defaultReasonForMode(mode)
      }

      const markBarrier = (reason: TerminalOutputBarrierReason) => {
        barrierReason = recordReason(barrierReason, reason)
      }

      const appendCsiPayload = (char: string) => {
        csiPayloadSuffix += char
        if (csiPayloadSuffix.length > CSI_PAYLOAD_SUFFIX_LIMIT) {
          csiPayloadSuffix = csiPayloadSuffix.slice(-CSI_PAYLOAD_SUFFIX_LIMIT)
        }
      }

      const processStringMode = (
        codePoint: number,
        stringMode: 'osc' | 'dcs' | 'apc',
      ) => {
        markBarrier(defaultReasonForMode(stringMode))

        if (codePoint === REPLACEMENT_CHARACTER) {
          markBarrier('control')
        }

        if (stringEscPending) {
          if (codePoint === 0x5c) {
            enterGround()
            return
          }
          if (codePoint === ESC) {
            stringEscPending = true
            return
          }
          stringEscPending = false
          return
        }

        if (codePoint === ESC) {
          stringEscPending = true
          return
        }
        if (codePoint === ST) {
          enterGround()
          return
        }
        if (stringMode === 'osc' && codePoint === BEL) {
          enterGround()
        }
      }

      for (let index = 0; index < data.length;) {
        const codePoint = data.codePointAt(index)
        if (codePoint === undefined) break
        const char = String.fromCodePoint(codePoint)
        index += char.length

        if (mode === 'ground') {
          if (codePoint === REPLACEMENT_CHARACTER) {
            markBarrier('control')
            continue
          }
          if (codePoint === BEL) {
            markBarrier('turn_complete')
            continue
          }
          if (codePoint === ESC) {
            markBarrier('control')
            enterEsc()
            continue
          }
          if (codePoint === CSI) {
            markBarrier('control')
            enterCsi()
            continue
          }
          if (codePoint === OSC) {
            markBarrier('osc52')
            enterStringMode('osc')
            continue
          }
          if (codePoint === DCS) {
            markBarrier('control')
            enterStringMode('dcs')
            continue
          }
          if (codePoint === SOS || codePoint === PM) {
            markBarrier('control')
            enterStringMode('apc')
            continue
          }
          if (codePoint === APC) {
            markBarrier('control')
            enterStringMode('apc')
            continue
          }
          if (isGroundControlBarrier(codePoint)) {
            markBarrier('control')
          }
          continue
        }

        if (mode === 'esc') {
          markBarrier('control')
          if (codePoint === 0x5b) {
            enterCsi()
            continue
          }
          if (codePoint === 0x58 || codePoint === 0x5e) {
            enterStringMode('apc')
            continue
          }
          if (codePoint === 0x5d) {
            markBarrier('osc52')
            enterStringMode('osc')
            continue
          }
          if (codePoint === 0x50) {
            enterStringMode('dcs')
            continue
          }
          if (codePoint === 0x5f) {
            enterStringMode('apc')
            continue
          }
          if (codePoint === ESC) {
            enterEsc()
            continue
          }
          if (codePoint === CSI) {
            enterCsi()
            continue
          }
          if (codePoint === OSC) {
            markBarrier('osc52')
            enterStringMode('osc')
            continue
          }
          if (codePoint === DCS) {
            enterStringMode('dcs')
            continue
          }
          if (codePoint === SOS || codePoint === PM) {
            enterStringMode('apc')
            continue
          }
          if (codePoint === APC) {
            enterStringMode('apc')
            continue
          }
          if (isEscIntermediateByte(codePoint)) {
            continue
          }
          if (isEscFinalByte(codePoint)) {
            enterGround()
          }
          continue
        }

        if (mode === 'csi') {
          markBarrier('control')
          if (codePoint === REPLACEMENT_CHARACTER) {
            markBarrier('control')
            continue
          }
          if (codePoint === ESC) {
            enterEsc()
            continue
          }
          if (codePoint === BEL) {
            markBarrier('turn_complete')
            continue
          }
          if (codePoint === ST) {
            enterGround()
            continue
          }
          if (isCsiFinalByte(codePoint)) {
            markBarrier(classifyCsiFinal(csiPayloadSuffix, char))
            enterGround()
            continue
          }
          appendCsiPayload(char)
          continue
        }

        processStringMode(codePoint, mode)
      }

      const stateAfter = snapshot(mode)
      const ground = mode === 'ground'
      if (!barrierReason) {
        return {
          barrier: false,
          ground,
          stateBefore,
          stateAfter,
        }
      }

      return {
        barrier: true,
        reason: barrierReason,
        ground,
        stateBefore,
        stateAfter,
      }
    },

    isGround(): boolean {
      return mode === 'ground'
    },
  }

  return scanner
}
