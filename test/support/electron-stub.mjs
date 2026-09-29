// Minimal `electron` stand-in for boundary tests. `app.getPath('userData')` points at a
// throwaway temp dir so tests never touch a real profile. `safeStorage` is a reversible
// fake with a marker, so a test can tell ciphertext it wrote from a corrupt file.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'clui-test-'))
export const app = { getPath: (key) => (key === 'userData' ? userData : userData) }
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('fake-enc:' + s),
  decryptString: (b) => {
    const s = Buffer.from(b).toString('utf8')
    if (!s.startsWith('fake-enc:')) throw new Error('decrypt failed')
    return s.slice(9)
  }
}
// Always rejects, so a test takes the no-Trash fallback and never fills the real Trash.
export const shell = { trashItem: async () => { throw new Error('no Trash in tests') } }
// Loaded by the browser manager's module graph; no test constructs them.
export const session = {}
export class WebContentsView {}
export default { app, safeStorage, session, shell, WebContentsView }
