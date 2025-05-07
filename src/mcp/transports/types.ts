export enum TransportType {
  STDIO = "stdio",
  HTTP = "http",
}

export interface TransportConfig {
  port?: number;
  host?: string;
}
