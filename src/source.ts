import type {
  RawInboxResponse,
  RawNotificationsResponse,
  RawTicketListResponse,
  RawUnreadNotificationsResponse
} from './overview'

/**
 * The only boundary that changes when the HTTP source is added. The methods
 * return the platform API's JSON shapes unchanged; the worker converts them.
 */
export interface TaskboardDataSource {
  inbox(): Promise<RawInboxResponse>
  waitingOnCounterparts(): Promise<RawInboxResponse>
  collaboratingTickets(): Promise<RawTicketListResponse>
  unreadNotifications(): Promise<RawUnreadNotificationsResponse>
  notifications(): Promise<RawNotificationsResponse>
  markNotificationsRead(ids: readonly number[]): Promise<void>
  markAllNotificationsRead(upTo: number): Promise<void>
}
