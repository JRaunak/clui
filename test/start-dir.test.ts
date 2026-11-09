// Where the folder dialog opens when the path asked for doesn't exist yet.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nearestDir } from '../src/main/lib/start-dir.ts'
import { equal } from './support/harness.mjs'

const dirs = (...have: string[]) => async (p: string): Promise<boolean> => have.includes(p)
const home = homedir()

equal(await nearestDir(join(home, '.clui'), '/ws', dirs(home, '/ws')), home, 'start: a missing ~/.clui opens home, not the default workspace')
equal(await nearestDir('/a/b/c', '/ws', dirs('/a', '/ws')), '/a', 'start: climbs to the nearest folder that exists')
equal(await nearestDir('/a/b', '/ws', dirs('/a/b', '/ws')), '/a/b', 'start: an existing folder opens as is')
equal(await nearestDir('', '/ws', dirs('/ws')), '/ws', 'start: nothing asked opens the default workspace')
equal(await nearestDir('', '/ws', dirs()), undefined, 'start: a missing default workspace leaves it to the dialog')
equal(await nearestDir('rel/x', '/ws', dirs('/ws')), '/ws', 'start: a relative path counts as nothing asked')
equal(await nearestDir('/a/b', '', dirs()), undefined, 'start: the climb stops at the root')
