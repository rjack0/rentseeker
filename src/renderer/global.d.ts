import type { DashboardApi } from '@shared/types'

declare global {
  interface Window {
    rentSeeker: DashboardApi
  }
}

export {}

