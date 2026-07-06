// Returns a human-readable reason string if `request` (resolved from `issuer`) is a
// forbidden node-only import for the browser bundle, else null. See migration spec §4 risk 5.
export function forbiddenNodeOnlyImport(request, issuer) {
  const req = request ?? '';
  const iss = issuer ?? '';
  const always = [
    { name: 'core guarded-fetch (node-only SSRF)', re: /guarded-fetch(\.[mc]?js)?$/ },
    // Anchored to a path segment so a browser-safe "observer.js"/"nameserver.js" can't false-trip.
    { name: 'fred node server barrel', re: /manifest-mcp-fred[\\/](?:.*[\\/])?server(?:[\\/]|\.[mc]?js|$)/ },
    { name: 'sdk node subpath', re: /manifest-sdk[\\/](dist[\\/])?node(\.[mc]?js)?$/ },
  ];
  for (const { name, re } of always) {
    if (re.test(req)) return `forbidden node-only import "${req}" (${name}) from ${iss || 'entry'}`;
  }
  const benignIssuer = /node_modules[\\/](@modelcontextprotocol[\\/]sdk|@manifest-network[\\/]manifest-mcp-chain)[\\/]/.test(iss);
  if (!benignIssuer) {
    const builtins = [
      { name: 'undici', re: /^undici(\/|$)/ },
      { name: 'node:async_hooks', re: /^(node:)?async_hooks$/ },
    ];
    for (const { name, re } of builtins) {
      if (re.test(req)) return `node builtin "${req}" (${name}) reached the browser graph from ${iss || 'entry'}`;
    }
  }
  return null;
}
