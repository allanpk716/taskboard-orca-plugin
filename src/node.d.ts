declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array): Hash
    digest(): Uint8Array
  }
  export function createHash(algorithm: string): Hash
  export function randomBytes(size: number): Uint8Array
  export function randomUUID(): string
}

declare module 'node:http' {
  export interface IncomingMessage {
    url: string | undefined
  }
  export interface ServerResponse {
    writeHead(
      statusCode: number,
      headers: Record<string, string>
    ): ServerResponse
    end(body?: string): ServerResponse
  }
  export interface AddressInfo {
    port: number
  }
  export interface Server {
    address(): AddressInfo | string | null
    close(callback?: (error?: Error) => void): void
    on(event: 'error', listener: (error: Error) => void): void
    on(
      event: 'connection',
      listener: (socket: {
        destroy(): void
        on(event: string, listener: () => void): void
      }) => void
    ): void
    listen(port: number, host: string, callback?: () => void): void
  }
  export function createServer(
    handler: (
      request: IncomingMessage,
      response: ServerResponse
    ) => void
  ): Server
}

declare module 'node:os' {
  export function hostname(): string
}
