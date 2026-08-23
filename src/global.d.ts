type ChannelState = "vanilla" | "installed" | "foreign" | "broken";

interface ChannelStatus {
  flavour: string;
  version: string;
  resourcesPath: string;
  executablePath: string;
  state: ChannelState;
  detail: string;
}

interface Overview {
  supported: boolean;
  runtimeReady: boolean;
  message: string;
  channels: ChannelStatus[];
}

interface GoLiveApi {
  status(): Promise<Overview>;
  install(): Promise<Overview>;
  repair(): Promise<Overview>;
  uninstall(): Promise<Overview>;
  license(): Promise<string>;
}

interface Window {
  golive: GoLiveApi;
}
