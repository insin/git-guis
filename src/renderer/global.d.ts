import type { AppApi, GitApi } from '../shared/api'

declare global {
  interface Window {
    appApi: AppApi
    gitApi: GitApi
  }
}
