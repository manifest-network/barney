import { HelpCircle, Rocket, Terminal, Keyboard, Layers } from 'lucide-react';

const CAPABILITIES = [
  'Deploy apps from a manifest file or the built-in catalog',
  'Stop, restart, and update running apps',
  'Check credits and spending rate',
  'List apps and view their status',
  'View logs for running containers',
  'Browse the provider catalog and resource tiers',
  'Query the chain for leases, balances, and more',
];

const EXAMPLES = [
  'Deploy postgres',
  "What's running?",
  'Check my credits',
  'Show logs for my-app',
  'Stop my-app',
  'Browse catalog',
];

const TIERS = [
  { name: 'micro', cpu: '0.5', mem: '512 Mi', disk: '512 Mi' },
  { name: 'small', cpu: '1', mem: '1 Gi', disk: '1 Gi' },
  { name: 'medium', cpu: '2', mem: '2 Gi', disk: '2 Gi' },
  { name: 'large', cpu: '4', mem: '4 Gi', disk: '4 Gi' },
];

const SHORTCUTS = [
  { key: 'Enter', action: 'Send message' },
  { key: 'Shift + Enter', action: 'New line' },
  { key: '\u2191 \u2193', action: 'Browse input history' },
  { key: '/', action: 'Focus chat input' },
];

export function HelpCard() {
  return (
    <div className="help-card" role="region" aria-label="Help reference">
      <div className="help-card__header">
        <HelpCircle className="w-5 h-5 text-primary-400" aria-hidden="true" />
        <span className="help-card__title">Quick Reference</span>
      </div>

      {/* Capabilities */}
      <div className="help-card__section">
        <div className="help-card__section-header">
          <Rocket className="w-3.5 h-3.5" aria-hidden="true" />
          <span>What I can do</span>
        </div>
        <ul className="help-card__list">
          {CAPABILITIES.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      {/* Example prompts */}
      <div className="help-card__section">
        <div className="help-card__section-header">
          <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Try saying</span>
        </div>
        <div className="help-card__examples">
          {EXAMPLES.map((text) => (
            <span key={text} className="help-card__example">{text}</span>
          ))}
        </div>
      </div>

      {/* Resource tiers */}
      <div className="help-card__section">
        <div className="help-card__section-header">
          <Layers className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Resource tiers</span>
        </div>
        <div className="help-card__table-wrap">
          <table className="help-card__table">
            <thead>
              <tr>
                <th>Tier</th>
                <th>CPU</th>
                <th>Memory</th>
                <th>Storage</th>
              </tr>
            </thead>
            <tbody>
              {TIERS.map((t) => (
                <tr key={t.name}>
                  <td><span className="help-card__tier-badge">{t.name}</span></td>
                  <td>{t.cpu}</td>
                  <td>{t.mem}</td>
                  <td>{t.disk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Keyboard shortcuts */}
      <div className="help-card__section">
        <div className="help-card__section-header">
          <Keyboard className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Keyboard shortcuts</span>
        </div>
        <div className="help-card__shortcuts">
          {SHORTCUTS.map((s) => (
            <div key={s.key} className="help-card__shortcut">
              <kbd className="help-card__kbd">{s.key}</kbd>
              <span>{s.action}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="help-card__footer">
        Type <kbd className="help-card__kbd">/help</kbd> anytime to show this again.
      </p>
    </div>
  );
}
