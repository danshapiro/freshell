#!/usr/bin/env node

const scenario = process.argv[2] || 'agent-burst'
const lineCount = Number(process.argv[3] || 1200)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ESC = '\u001b'
const BEL = '\u0007'
const ST = `${ESC}\\`

function write(data) {
  process.stdout.write(data)
}

async function agentBurst() {
  write(`${ESC}]0;Freshell proof agent burst${BEL}`)
  write(`${ESC}[?25l`)
  for (let i = 1; i <= lineCount; i += 1) {
    if (i % 200 === 1) {
      write(`${ESC}[38;5;39mthinking${ESC}[0m ${String(i).padStart(5, '0')} scanning repository\r`)
      await sleep(2)
      write(`${ESC}[2K\r`)
    }
    if (i % 97 === 0) {
      write(`${ESC}]52;c;${Buffer.from(`clipboard-${i}`).toString('base64')}${BEL}`)
    }
    if (i % 251 === 0) {
      write(`${ESC}P1;2;3|proof-dcs-${i}${ST}`)
    }
    const severity = i % 17 === 0 ? `${ESC}[33mwarn${ESC}[0m` : `${ESC}[32mok${ESC}[0m`
    write(`[${severity}] ${String(i).padStart(5, '0')} edit src/example-${i % 23}.ts chunk=${i % 11} tokens=${1000 + i}\n`)
    if (i % 128 === 0) await sleep(4)
  }
  write(`${ESC}[?25h`)
  write(`FRESHELL_PROOF_DONE:${scenario}:${lineCount}\n`)
}

async function controlBarrier() {
  write(`${ESC}]0;Freshell proof split OSC`)
  await sleep(5)
  write(`${BEL}after-title\n`)
  write(`${ESC}[38;5;196m`)
  await sleep(5)
  write(`split-sgr-red${ESC}[0m\n`)
  write(`${ESC}Pq`)
  await sleep(5)
  write(`dcs-payload${ST}after-dcs\n`)
  write(`${ESC}[?2026;1$y`)
  write(`${ESC}]52;c;${Buffer.from('proof clipboard').toString('base64')}${BEL}`)
  write('\uFFFD replacement-byte-sentinel\n')
  write(`FRESHELL_PROOF_DONE:${scenario}:${lineCount}\n`)
}

if (scenario === 'control-barrier') {
  await controlBarrier()
} else {
  await agentBurst()
}
