export enum TransportType {
  HTTP = "http",
  SSE = "sse",
  STDIO = "stdio",
}

export interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ServerConfig {
  port: number;
  host: string;
}
