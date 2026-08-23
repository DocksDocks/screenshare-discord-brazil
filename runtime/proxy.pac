function FindProxyForURL(url, host) {
  var normalized = String(host).toLowerCase();
  if (normalized === "discord.gg" || normalized.endsWith(".discord.gg")) {
    return "SOCKS5 127.0.0.1:9060";
  }
  return "DIRECT";
}
