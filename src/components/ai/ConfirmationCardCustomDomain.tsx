/**
 * Confirmation-card sub-views for the set_custom_domain TX flow.
 *
 * Lives next to ConfirmationCard so it stays close to the main confirmation
 * UX, but isolates the DNS-record-table rendering so the post-deploy
 * embedded input (deploy_app + customDomain override) and this standalone
 * confirmation render don't drift into a tangled `if/else` inside one
 * monster component.
 */

import { Copy, CheckCheck } from 'lucide-react';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { apexRecordKindLabel } from '../../utils/customDomainValidation';
import type { CustomDomainBranchData } from './customDomainBranchData';

export type { CustomDomainBranchData };

/** The standalone set_custom_domain confirmation surface — DNS record table
 *  plus apex/Cloudflare hints, or a clear-warning when customDomain === "". */
export function CustomDomainBranch({ data }: { data: CustomDomainBranchData }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const isClear = data.customDomain === '';
  const target = data.expectedCnameTarget ?? '<provider FQDN — appears once the app is running>';
  const showTarget = !isClear && data.expectedCnameTarget;
  // Apex domains can't take a plain CNAME (RFC 1034 §3.6.2); validateAll surfaces a
  // warning we use as the apex signal so the DNS record table reads correctly.
  const isApex = !!data.warning;
  const recordType = apexRecordKindLabel(isApex);

  return (
    <div className="confirmation-details">
      {isClear ? (
        <div className="confirmation-payload" role="alert">
          <p className="text-sm text-warning">
            This will clear <code className="font-mono">{data.currentDomain}</code> from <code className="font-mono">{data.appName}</code>.
            HTTPS at that hostname will stop working until you point it at a new lease.
          </p>
        </div>
      ) : (
        <>
          <p className="confirmation-details-title">DNS record to add at your registrar</p>
          <table className="custom-domain-dns-table" aria-label="DNS record">
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Value</th>
                <th>TTL</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code className="font-mono">{recordType}</code></td>
                <td>
                  <code className="font-mono">{data.customDomain}</code>
                  {' '}
                  <button
                    type="button"
                    onClick={() => copyToClipboard(data.customDomain)}
                    className="btn-icon"
                    aria-label="Copy domain"
                    title="Copy"
                  >
                    {isCopied(data.customDomain) ? (
                      <CheckCheck className="w-3.5 h-3.5 text-success" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-muted" />
                    )}
                  </button>
                </td>
                <td>
                  <code className="font-mono">{target}</code>
                  {showTarget && (
                    <>
                      {' '}
                      <button
                        type="button"
                        onClick={() => copyToClipboard(data.expectedCnameTarget!)}
                        className="btn-icon"
                        aria-label="Copy target"
                        title="Copy"
                      >
                        {isCopied(data.expectedCnameTarget!) ? (
                          <CheckCheck className="w-3.5 h-3.5 text-success" />
                        ) : (
                          <Copy className="w-3.5 h-3.5 text-muted" />
                        )}
                      </button>
                    </>
                  )}
                </td>
                <td>Auto / 300</td>
              </tr>
            </tbody>
          </table>

          <CloudflareProxyHint />

          {data.currentDomain !== '' && (
            <p className="text-xs text-muted mt-1">
              Replacing existing domain <code className="font-mono">{data.currentDomain}</code>.
            </p>
          )}

          {data.warning && (
            <p className="text-sm text-warning mt-2" role="alert">
              {data.warning}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Cloudflare proxy off, please. Single source of truth used by both the
 *  standalone CustomDomainBranch and the deploy_app inline input section. */
export function CloudflareProxyHint({ inline = false }: { inline?: boolean }) {
  return (
    <p className={inline ? 'text-xs text-muted' : 'text-xs text-muted mt-2'}>
      Cloudflare users: turn the orange-cloud proxy <strong>off</strong> for this record. Issuance won't complete with proxy on.
    </p>
  );
}
