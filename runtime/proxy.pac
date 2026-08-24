function FindProxyForURL(url, host) {
  var normalized = String(host).toLowerCase();
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  if (normalized === "discord.gg" || normalized.endsWith(".discord.gg")) {
    return "SOCKS5 127.0.0.1:__GATEWAY_RELAY_PORT__";
  }
  return "DIRECT";
}
