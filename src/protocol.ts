import type { Overview, TaskboardNotification } from './overview'

export type { Overview, TaskboardNotification }

export type ConnectionState =
  | 'unconfigured'
  | 'disconnected'
  | 'expired'
  | 'connected'

export type ConnectionPhase =
  | 'idle'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'cancelled'

export interface ConnectionStatus {
  phase: ConnectionPhase
  message: string | null
}

export interface TaskboardSnapshot {
  state: ConnectionState
  platformUrl: string
  overview: Overview | null
  notifications: TaskboardNotification[]
  latestNotificationId: number | null
  unreadNotificationCount: number | null
  secretsAvailable: boolean
  addressError: string | null
  connection: ConnectionStatus
  refreshError: string | null
}

export interface ConnectionBeginResult {
  authorizationUrl: string | null
  snapshot: TaskboardSnapshot
}

declare module 'orca' {
  interface PluginRequests {
    'taskboard.getState': { output: TaskboardSnapshot }
    'config.save': { input: { platformUrl: string }; output: TaskboardSnapshot }
    'connection.begin': { output: ConnectionBeginResult }
    'connection.cancel': { output: TaskboardSnapshot }
    'connection.disconnect': { output: TaskboardSnapshot }
    'notifications.markRead': { input: { ids: number[] }; output: TaskboardSnapshot }
    'notifications.markAllRead': { input: { up_to: number }; output: TaskboardSnapshot }
  }

  interface PluginPanelEvents {
    'taskboard.changed': { snapshot: TaskboardSnapshot }
  }
}
