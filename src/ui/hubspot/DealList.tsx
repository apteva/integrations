// DealList — dense rows of deals. Same field shape as DealCard but
// for the "show me my open deals" use case. Footer summarises count
// and total $ across all rows (not just the visible ones).

import { Card, CardHeader, StatusPill, Row } from "@apteva/ui-kit";
import { dealStageMeta, formatUSD, formatRelativeDate, recordUrl, addDaysISO, hubspotLogo } from "./lib/hubspot";

interface DealRow {
  deal_id: string;
  dealname?: string;
  amount?: string;
  dealstage?: string;
  dealstage_label?: string;
  closedate?: string;
  company_name?: string;
}

interface Props {
  items?: DealRow[];
  /** Headline shown in the card header. */
  title?: string;
  /** Subtitle below the title — e.g. "Open · sorted by close date". */
  subtitle?: string;
  /** Cap rendered rows; show "+N more" footer when exceeded. */
  max_rows?: number;
  portal_id?: string;
  preview?: boolean;
  projectId?: string;
}

const previewItems: DealRow[] = [
  { deal_id: "1", dealname: "Acme Q4 Renewal",         amount: "48000",  dealstage: "contractsent",          closedate: addDaysISO(7),  company_name: "Acme Logistics" },
  { deal_id: "2", dealname: "Globex Pilot",            amount: "24000",  dealstage: "presentationscheduled", closedate: addDaysISO(28), company_name: "Globex Innovations" },
  { deal_id: "3", dealname: "Initech Enterprise",      amount: "120000", dealstage: "decisionmakerboughtin", closedate: addDaysISO(14), company_name: "Initech Corp" },
  { deal_id: "4", dealname: "Soylent Expansion",       amount: "62000",  dealstage: "qualifiedtobuy",        closedate: addDaysISO(42), company_name: "Soylent Foods" },
  { deal_id: "5", dealname: "Hooli Multi-year",        amount: "315000", dealstage: "decisionmakerboughtin", closedate: addDaysISO(21), company_name: "Hooli" },
];

export default function DealList(props: Props) {
  const items = props.preview ? (props.items ?? previewItems) : (props.items ?? []);
  const max = props.max_rows ?? 6;
  const visible = items.slice(0, max);
  const overflow = items.length - visible.length;
  const total = items.reduce((acc, d) => acc + (Number(d.amount ?? 0) || 0), 0);

  return (
    <Card>
      <CardHeader
        logo={hubspotLogo}
        title={props.title || "Deals"}
        subtitle={props.subtitle || (items.length > 0 ? `${items.length} deal${items.length === 1 ? "" : "s"} · ${formatUSD(total)} total` : "No deals")}
      />
      {visible.length === 0 && (
        <div className="px-3 py-3 text-[11px] text-text-dim">No deals match.</div>
      )}
      {visible.map((d, i) => {
        const stage = dealStageMeta(d.dealstage, d.dealstage_label);
        return (
          <Row
            key={d.deal_id}
            flush={i === 0}
            href={recordUrl("deal", d.deal_id, props.portal_id)}
            title={d.dealname || `Deal ${d.deal_id}`}
            subtitle={d.company_name}
            trailing={
              <span className="inline-flex items-center gap-2">
                <span className="tabular-nums text-text">{formatUSD(d.amount)}</span>
                <StatusPill variant={stage.variant}>{stage.label}</StatusPill>
                {d.closedate && (
                  <span className="text-text-dim hidden sm:inline tabular-nums">{formatRelativeDate(d.closedate)}</span>
                )}
              </span>
            }
          />
        );
      })}
      {overflow > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-text-dim border-t border-border">
          +{overflow} more
        </div>
      )}
    </Card>
  );
}
