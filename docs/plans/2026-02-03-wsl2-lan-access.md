# WSL2 LAN Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically configure Windows port forwarding when running in WSL2 so external LAN devices can reach Freshell.

**Architecture:** New module `server/wsl-port-forward.ts` detects WSL2, checks existing port proxy rules via `netsh`, and launches an elevated PowerShell process to add/update rules if needed. Called from `bootstrap.ts` after env file setup.

**Tech Stack:** Node.js child_process (execSync), Windows netsh, PowerShell elevation via `-Verb RunAs`

---

### Task 1: Create wsl-port-forward module with getWslIp

**Files:**
- Create: `server/wsl-port-forward.ts`
- Create: `test/unit/server/wsl-port-forward.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/server/wsl-port-forward.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'

vi.mock('child_process')

import { getWslIp } from '../../../server/wsl-port-forward.js'

describe('wsl-port-forward', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('getWslIp', () => {
    it('returns first IPv4 address from hostname -I', () => {
      vi.mocked(execSync).mockReturnValue('172.30.149.249 172.17.0.1 \n')

      const ip = getWslIp()

      expect(ip).toBe('172.30.149.249')
    })

    it('returns null when hostname -I fails', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command failed')
      })

      const ip = getWslIp()

      expect(ip).toBeNull()
    })

    it('returns null when no IPs found', () => {
      vi.mocked(execSync).mockReturnValue('')

      const ip = getWslIp()

      expect(ip).toBeNull()
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: FAIL - module not found

**Step 3: Write minimal implementation**

```typescript
// server/wsl-port-forward.ts
import { execSync } from 'child_process'

/**
 * Get the current WSL2 IP address.
 * Returns the first IPv4 address from `hostname -I`.
 */
export function getWslIp(): string | null {
  try {
    const output = execSync('hostname -I', { encoding: 'utf-8', timeout: 5000 })
    const ips = output.trim().split(/\s+/).filter(Boolean)
    return ips[0] || null
  } catch {
    return null
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/wsl-port-forward.ts test/unit/server/wsl-port-forward.test.ts
git commit -m "feat(wsl): add getWslIp function"
```

---

### Task 2: Add parsePortProxyRules function

**Files:**
- Modify: `server/wsl-port-forward.ts`
- Modify: `test/unit/server/wsl-port-forward.test.ts`

**Step 1: Write the failing test**

Add to test file:

```typescript
import { getWslIp, parsePortProxyRules } from '../../../server/wsl-port-forward.js'

describe('parsePortProxyRules', () => {
  it('parses netsh portproxy output into map', () => {
    const output = `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         5173        172.30.149.249  5173
`
    const rules = parsePortProxyRules(output)

    expect(rules.get(3001)).toBe('172.30.149.249')
    expect(rules.get(5173)).toBe('172.30.149.249')
  })

  it('returns empty map for empty output', () => {
    const rules = parsePortProxyRules('')

    expect(rules.size).toBe(0)
  })

  it('ignores rules not listening on 0.0.0.0', () => {
    const output = `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
127.0.0.1       8080        172.30.149.249  8080
0.0.0.0         3001        172.30.149.249  3001
`
    const rules = parsePortProxyRules(output)

    expect(rules.has(8080)).toBe(false)
    expect(rules.get(3001)).toBe('172.30.149.249')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: FAIL - parsePortProxyRules not exported

**Step 3: Write minimal implementation**

Add to `server/wsl-port-forward.ts`:

```typescript
/**
 * Parse netsh interface portproxy show v4tov4 output.
 * Returns a Map of listenPort -> connectAddress for rules listening on 0.0.0.0.
 */
export function parsePortProxyRules(output: string): Map<number, string> {
  const rules = new Map<number, string>()

  for (const line of output.split('\n')) {
    // Match lines like: 0.0.0.0         3001        172.30.149.249  3001
    const match = line.match(/^([\d.]+)\s+(\d+)\s+([\d.]+)\s+(\d+)/)
    if (match) {
      const [, listenAddr, listenPort, connectAddr] = match
      if (listenAddr === '0.0.0.0') {
        rules.set(parseInt(listenPort, 10), connectAddr)
      }
    }
  }

  return rules
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/wsl-port-forward.ts test/unit/server/wsl-port-forward.test.ts
git commit -m "feat(wsl): add parsePortProxyRules function"
```

---

### Task 3: Add getExistingPortProxyRules function

**Files:**
- Modify: `server/wsl-port-forward.ts`
- Modify: `test/unit/server/wsl-port-forward.test.ts`

**Step 1: Write the failing test**

Add to test file:

```typescript
import { getWslIp, parsePortProxyRules, getExistingPortProxyRules } from '../../../server/wsl-port-forward.js'

describe('getExistingPortProxyRules', () => {
  it('calls netsh and parses output', () => {
    vi.mocked(execSync).mockReturnValue(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`)

    const rules = getExistingPortProxyRules()

    expect(execSync).toHaveBeenCalledWith(
      '/mnt/c/Windows/System32/netsh.exe interface portproxy show v4tov4',
      expect.objectContaining({ encoding: 'utf-8' })
    )
    expect(rules.get(3001)).toBe('172.30.149.249')
  })

  it('returns empty map when netsh fails', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('Command failed')
    })

    const rules = getExistingPortProxyRules()

    expect(rules.size).toBe(0)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: FAIL - getExistingPortProxyRules not exported

**Step 3: Write minimal implementation**

Add to `server/wsl-port-forward.ts`:

```typescript
/**
 * Query existing Windows port proxy rules.
 * Returns a Map of listenPort -> connectAddress.
 */
export function getExistingPortProxyRules(): Map<number, string> {
  try {
    const output = execSync(
      '/mnt/c/Windows/System32/netsh.exe interface portproxy show v4tov4',
      { encoding: 'utf-8', timeout: 10000 }
    )
    return parsePortProxyRules(output)
  } catch {
    return new Map()
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/wsl-port-forward.ts test/unit/server/wsl-port-forward.test.ts
git commit -m "feat(wsl): add getExistingPortProxyRules function"
```

---

### Task 4: Add needsPortForwardingUpdate function

**Files:**
- Modify: `server/wsl-port-forward.ts`
- Modify: `test/unit/server/wsl-port-forward.test.ts`

**Step 1: Write the failing test**

Add to test file:

```typescript
import {
  getWslIp,
  parsePortProxyRules,
  getExistingPortProxyRules,
  needsPortForwardingUpdate
} from '../../../server/wsl-port-forward.js'

describe('needsPortForwardingUpdate', () => {
  it('returns true when no rules exist', () => {
    const rules = new Map<number, string>()

    const needs = needsPortForwardingUpdate('172.30.149.249', rules)

    expect(needs).toBe(true)
  })

  it('returns true when rules point to wrong IP', () => {
    const rules = new Map<number, string>([
      [3001, '172.30.100.100'],
      [5173, '172.30.100.100'],
    ])

    const needs = needsPortForwardingUpdate('172.30.149.249', rules)

    expect(needs).toBe(true)
  })

  it('returns true when only one port is configured', () => {
    const rules = new Map<number, string>([
      [3001, '172.30.149.249'],
    ])

    const needs = needsPortForwardingUpdate('172.30.149.249', rules)

    expect(needs).toBe(true)
  })

  it('returns false when both ports point to correct IP', () => {
    const rules = new Map<number, string>([
      [3001, '172.30.149.249'],
      [5173, '172.30.149.249'],
    ])

    const needs = needsPortForwardingUpdate('172.30.149.249', rules)

    expect(needs).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: FAIL - needsPortForwardingUpdate not exported

**Step 3: Write minimal implementation**

Add to `server/wsl-port-forward.ts`:

```typescript
const REQUIRED_PORTS = [3001, 5173]

/**
 * Check if port forwarding rules need to be updated.
 * Returns true if any required port is missing or points to wrong IP.
 */
export function needsPortForwardingUpdate(
  wslIp: string,
  existingRules: Map<number, string>
): boolean {
  for (const port of REQUIRED_PORTS) {
    if (existingRules.get(port) !== wslIp) {
      return true
    }
  }
  return false
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/wsl-port-forward.ts test/unit/server/wsl-port-forward.test.ts
git commit -m "feat(wsl): add needsPortForwardingUpdate function"
```

---

### Task 5: Add buildPortForwardingScript function

**Files:**
- Modify: `server/wsl-port-forward.ts`
- Modify: `test/unit/server/wsl-port-forward.test.ts`

**Step 1: Write the failing test**

Add to test file:

```typescript
import {
  getWslIp,
  parsePortProxyRules,
  getExistingPortProxyRules,
  needsPortForwardingUpdate,
  buildPortForwardingScript
} from '../../../server/wsl-port-forward.js'

describe('buildPortForwardingScript', () => {
  it('generates PowerShell script with delete and add commands', () => {
    const script = buildPortForwardingScript('172.30.149.249')

    expect(script).toContain('netsh interface portproxy delete v4tov4 listenport=3001')
    expect(script).toContain('netsh interface portproxy delete v4tov4 listenport=5173')
    expect(script).toContain('netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3001 connectaddress=172.30.149.249 connectport=3001')
    expect(script).toContain('netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=172.30.149.249 connectport=5173')
  })

  it('includes firewall rule commands', () => {
    const script = buildPortForwardingScript('172.30.149.249')

    expect(script).toContain('netsh advfirewall firewall delete rule name="Freshell LAN Access"')
    expect(script).toContain('netsh advfirewall firewall add rule name="Freshell LAN Access"')
    expect(script).toContain('localport=3001,5173')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: FAIL - buildPortForwardingScript not exported

**Step 3: Write minimal implementation**

Add to `server/wsl-port-forward.ts`:

```typescript
/**
 * Build PowerShell script to configure port forwarding and firewall.
 */
export function buildPortForwardingScript(wslIp: string): string {
  const commands: string[] = []

  // Delete existing rules (ignore errors if they don't exist)
  for (const port of REQUIRED_PORTS) {
    commands.push(
      `netsh interface portproxy delete v4tov4 listenport=${port} listenaddress=0.0.0.0 2>$null`
    )
  }

  // Add new rules
  for (const port of REQUIRED_PORTS) {
    commands.push(
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${port} connectaddress=${wslIp} connectport=${port}`
    )
  }

  // Firewall rule (delete then add for idempotency)
  commands.push(`netsh advfirewall firewall delete rule name="Freshell LAN Access" 2>$null`)
  commands.push(
    `netsh advfirewall firewall add rule name="Freshell LAN Access" dir=in action=allow protocol=tcp localport=${REQUIRED_PORTS.join(',')}`
  )

  return commands.join('; ')
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/wsl-port-forward.ts test/unit/server/wsl-port-forward.test.ts
git commit -m "feat(wsl): add buildPortForwardingScript function"
```

---

### Task 6: Add setupWslPortForwarding main function

**Files:**
- Modify: `server/wsl-port-forward.ts`
- Modify: `test/unit/server/wsl-port-forward.test.ts`

**Step 1: Write the failing test**

Add to test file:

```typescript
import {
  getWslIp,
  parsePortProxyRules,
  getExistingPortProxyRules,
  needsPortForwardingUpdate,
  buildPortForwardingScript,
  setupWslPortForwarding
} from '../../../server/wsl-port-forward.js'
import fs from 'fs'

vi.mock('fs')

describe('setupWslPortForwarding', () => {
  beforeEach(() => {
    // Default: not WSL2
    vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.10.0')
  })

  it('returns not-wsl2 when not running in WSL2', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.10.0-generic')

    const result = setupWslPortForwarding()

    expect(result).toBe('not-wsl2')
  })

  it('returns skipped when rules are already correct', () => {
    // Mock WSL2 detection
    vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.15.0-microsoft-standard-WSL2')

    // Mock getWslIp
    vi.mocked(execSync)
      .mockReturnValueOnce('172.30.149.249\n') // hostname -I
      .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         5173        172.30.149.249  5173
`) // netsh show

    const result = setupWslPortForwarding()

    expect(result).toBe('skipped')
  })

  it('returns failed when WSL IP cannot be detected', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.15.0-microsoft-standard-WSL2')
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('Command failed')
    })

    const result = setupWslPortForwarding()

    expect(result).toBe('failed')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: FAIL - setupWslPortForwarding not exported

**Step 3: Write minimal implementation**

Add to `server/wsl-port-forward.ts`:

```typescript
import fs from 'fs'

/**
 * Check if running inside WSL2.
 */
function isWSL2(): boolean {
  try {
    const version = fs.readFileSync('/proc/version', 'utf-8')
    return version.toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}

export type SetupResult = 'success' | 'skipped' | 'failed' | 'not-wsl2'

/**
 * Set up Windows port forwarding for WSL2 LAN access.
 *
 * - Detects if running in WSL2
 * - Checks existing port proxy rules
 * - Launches elevated PowerShell to add/update rules if needed
 *
 * Returns:
 * - 'not-wsl2': Not running in WSL2, no action needed
 * - 'skipped': Rules already configured correctly
 * - 'success': Rules were added/updated successfully
 * - 'failed': Failed to configure (UAC dismissed or error)
 */
export function setupWslPortForwarding(): SetupResult {
  if (!isWSL2()) {
    return 'not-wsl2'
  }

  const wslIp = getWslIp()
  if (!wslIp) {
    console.error('[wsl-port-forward] Failed to detect WSL2 IP address')
    return 'failed'
  }

  const existingRules = getExistingPortProxyRules()
  if (!needsPortForwardingUpdate(wslIp, existingRules)) {
    console.log(`[wsl-port-forward] Rules up to date for ${wslIp}`)
    return 'skipped'
  }

  console.log(`[wsl-port-forward] Configuring port forwarding for ${wslIp}...`)
  console.log('[wsl-port-forward] UAC prompt required - please approve to enable LAN access')

  try {
    const script = buildPortForwardingScript(wslIp)
    // Escape single quotes for PowerShell
    const escapedScript = script.replace(/'/g, "''")

    execSync(
      `powershell.exe -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '${escapedScript}'"`,
      { encoding: 'utf-8', timeout: 60000, stdio: 'inherit' }
    )

    console.log('[wsl-port-forward] Port forwarding configured successfully')
    return 'success'
  } catch (err: any) {
    console.error(`[wsl-port-forward] Failed to configure: ${err?.message || err}`)
    return 'failed'
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run test/unit/server/wsl-port-forward.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/wsl-port-forward.ts test/unit/server/wsl-port-forward.test.ts
git commit -m "feat(wsl): add setupWslPortForwarding main function"
```

---

### Task 7: Integrate with bootstrap.ts

**Files:**
- Modify: `server/bootstrap.ts`

**Step 1: Write the failing test**

This is an integration step - we'll verify manually that bootstrap calls the setup function.

**Step 2: Modify bootstrap.ts**

Add import at top of file (after existing imports):

```typescript
import { setupWslPortForwarding } from './wsl-port-forward.js'
```

Add call after `ensureEnvFile` result handling (before the closing of the file, around line 311):

```typescript
// --- WSL2 Port Forwarding ---
// Configure Windows port forwarding for LAN access when running in WSL2
const portForwardResult = setupWslPortForwarding()
if (portForwardResult === 'success') {
  console.log('[bootstrap] WSL2 port forwarding configured')
} else if (portForwardResult === 'failed') {
  console.warn('[bootstrap] WSL2 port forwarding failed - LAN access may not work')
}
```

**Step 3: Run all tests to verify nothing broke**

Run: `npm test -- --run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add server/bootstrap.ts
git commit -m "feat(wsl): integrate port forwarding into bootstrap"
```

---

### Task 8: Manual verification

**Step 1: Start the dev server in WSL2**

Run: `npm run dev`

Expected output should include one of:
- `[wsl-port-forward] Rules up to date for 172.x.x.x` (if already configured)
- `[wsl-port-forward] UAC prompt required...` followed by UAC dialog
- `[wsl-port-forward] Port forwarding configured successfully` (after UAC approval)

**Step 2: Verify port forwarding was configured**

Run: `/mnt/c/Windows/System32/netsh.exe interface portproxy show v4tov4`

Expected: Rules for ports 3001 and 5173 pointing to your WSL2 IP

**Step 3: Test from another device**

From another device on the LAN, navigate to `http://<windows-lan-ip>:5173`

Expected: Freshell UI loads

**Step 4: Commit final changes if any adjustments needed**

---

### Task 9: Final cleanup and PR

**Step 1: Run full test suite**

Run: `npm test -- --run`
Expected: All tests pass

**Step 2: Create final commit if needed**

**Step 3: Use finishing-a-development-branch skill**

Run the skill to merge or create PR as appropriate.
