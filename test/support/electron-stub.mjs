// Minimal `electron` stand-in for boundary tests. Only `app.getPath('userData')` is
// stubbed, pointed at a throwaway temp dir so tests never touch a real profile.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'clui-test-'))
export const app = { getPath: (key) => (key === 'userData' ? userData : userData) }
export default { app }
