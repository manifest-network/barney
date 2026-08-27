function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function labelText(labels) {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

export class RelayMetrics {
  constructor() {
    this.counters = new Map();
    this.activeRequests = 0;
  }

  increment(name, labels = {}, amount = 1) {
    const sortedLabels = Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
    const key = JSON.stringify([name, sortedLabels]);
    const current = this.counters.get(key) ?? { name, labels: sortedLabels, value: 0 };
    current.value += amount;
    this.counters.set(key, current);
  }

  requestStarted() {
    this.activeRequests += 1;
  }

  requestFinished() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  render(ledgerState, config, concurrentState) {
    const lines = [
      '# HELP barney_morpheus_relay_requests_total Relay requests by bounded route and outcome.',
      '# TYPE barney_morpheus_relay_requests_total counter',
      '# HELP barney_morpheus_relay_rejections_total Requests rejected before or during upstream access.',
      '# TYPE barney_morpheus_relay_rejections_total counter',
      '# HELP barney_morpheus_relay_usage_tokens_total Provider-reported token usage.',
      '# TYPE barney_morpheus_relay_usage_tokens_total counter',
      '# HELP barney_morpheus_relay_usage_spend_micro_usd_total Accounted upstream spend in millionths of a US dollar.',
      '# TYPE barney_morpheus_relay_usage_spend_micro_usd_total counter',
    ];
    for (const metric of [...this.counters.values()].sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      return byName || JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels));
    })) {
      lines.push(`${metric.name}${labelText(metric.labels)} ${metric.value}`);
    }

    const identities = Object.values(ledgerState.identities);
    const maxRatio = (field, limit) => identities.reduce((maximum, usage) => Math.max(maximum, usage[field] / limit), 0);
    lines.push(
      '# HELP barney_morpheus_relay_active_requests Currently active paid upstream requests.',
      '# TYPE barney_morpheus_relay_active_requests gauge',
      `barney_morpheus_relay_active_requests ${this.activeRequests}`,
      '# HELP barney_morpheus_relay_identity_concurrent_max Highest current concurrency for one pseudonymous identity.',
      '# TYPE barney_morpheus_relay_identity_concurrent_max gauge',
      `barney_morpheus_relay_identity_concurrent_max ${concurrentState.maxIdentityActive}`,
      '# HELP barney_morpheus_relay_provider_spend_micro_usd Provider-wide accounted spend in the current UTC window.',
      '# TYPE barney_morpheus_relay_provider_spend_micro_usd gauge',
      `barney_morpheus_relay_provider_spend_micro_usd ${ledgerState.provider.spendMicroUsd}`,
      '# HELP barney_morpheus_relay_provider_budget_micro_usd Configured hard provider budget for the UTC window.',
      '# TYPE barney_morpheus_relay_provider_budget_micro_usd gauge',
      `barney_morpheus_relay_provider_budget_micro_usd ${config.providerDailyBudgetMicroUsd}`,
      '# HELP barney_morpheus_relay_identity_quota_max_ratio Maximum utilization across identities without exposing identity labels.',
      '# TYPE barney_morpheus_relay_identity_quota_max_ratio gauge',
      `barney_morpheus_relay_identity_quota_max_ratio{quota="requests"} ${maxRatio('requests', config.identityDailyRequests)}`,
      `barney_morpheus_relay_identity_quota_max_ratio{quota="tokens"} ${maxRatio('tokens', config.identityDailyTokens)}`,
      `barney_morpheus_relay_identity_quota_max_ratio{quota="spend"} ${maxRatio('spendMicroUsd', config.identityDailySpendMicroUsd)}`,
      '# HELP barney_morpheus_relay_accounting_window_info Current UTC accounting window.',
      '# TYPE barney_morpheus_relay_accounting_window_info gauge',
      `barney_morpheus_relay_accounting_window_info{window="${ledgerState.window}"} 1`,
      '',
    );
    return lines.join('\n');
  }
}
