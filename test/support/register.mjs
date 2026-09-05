// Preloaded via `node --import` so the resolve hook is active before any test imports src.
import { register } from 'node:module'
register('./loader.mjs', import.meta.url)
