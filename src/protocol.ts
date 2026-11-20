import type { Overview, TaskboardNotification } from './overview'

export type { Overview, TaskboardNotification }

export type ConnectionState =
  | 'unconfigured'
  | 'disconnected'
  | 'expired'
  | 'connected'

export interface TaskboardSnapshot {
  state: ConnectionState
  platformUrl: string
  overview: Overview | null
  notifications: TaskboardNotification[]
  latestNotificationId: number | null
}

declare module 'orca' {
  interface PluginRequests {
    'taskboard.getState': { output: TaskboardSnapshot }
    'config.save': { input: { platformUrl: string }; output: TaskboardSnapshot }
    'connection.connect': { output: TaskboardSnapshot }
    'connection.disconnect': { output: TaskboardSnapshot }
    'debug.setState': { input: { state: ConnectionState }; output: TaskboardSnapshot }
    'notifications.markRead': { input: { ids: number[] }; output: TaskboardSnapshot }
    'notifications.markAllRead': { input: { up_to: number }; output: TaskboardSnapshot }
  }

  interface PluginPanelEvents {
    'taskboard.changed': { snapshot: TaskboardSnapshot }
  }
}
