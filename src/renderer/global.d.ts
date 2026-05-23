import type { GitApi } from '../shared/api'

declare global {
  interface Window {
    gitApi: GitApi
  }
}
