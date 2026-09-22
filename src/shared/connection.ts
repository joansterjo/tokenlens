export interface SiteConnection {
  tabId: number;
  url: string;
  hostname: string;
  supported: boolean;
  hasPermission: boolean;
  connected: boolean;
  devtoolsOpen: boolean;
  reason?: string;
}

export interface ConnectionResponse {
  ok: boolean;
  status?: SiteConnection;
  error?: string;
}
