/**
 * Loads the Freshell server's `.env` at module-evaluation-anchor time, from
 * the same anchor bootstrap.ts resolved (FRESHELL_CONFIG_DIR when explicit,
 * else the process cwd).
 *
 * ENTRY-POINTS ONLY: import from `server/index.ts` AFTER './bootstrap.js' and
 * BEFORE every other Freshell module. Many modules read process.env at module
 * scope (logger constants, PTY env scrub, ...) — dotenv must already have
 * published .env values before their first evaluation. Vitest files that
 * import './bootstrap.js' directly are unaffected: this module is only
 * pulled through the real entry point.
 */
import path from 'path'
import dotenv from 'dotenv'
import { resolveProjectRoot } from './bootstrap.js'

dotenv.config({ path: path.join(resolveProjectRoot(), '.env') })
