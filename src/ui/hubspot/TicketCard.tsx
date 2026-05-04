// TicketCard — single HubSpot ticket. Subject + content body up top,
// priority pill (LOW/MED/HIGH/URGENT — color-coded), pipeline-stage
// pill, age, associated company. The card the demo uses for Acme's
// HIGH-priority API-latency ticket.

import { Card, CardHeader, StatusPill, DataList } from "@apteva/ui-kit";
import {
  ticketPriorityMeta, ticketStageMeta, recordUrl, faviconFor,
  pillToDot, timeAgo, minusHoursISO, hubspotLogo,
} from "./lib/hubspot";

interface Props {
  ticket_id: string;
  subject?: string;
  content?: string;
  /** HubSpot internal priority id: LOW | MEDIUM | HIGH | URGENT. */
  hs_ticket_priority?: string;
  /** Pipeline-stage id (per-pipeline; "1" is "New" in the default). */
  hs_pipeline_stage?: string;
  /** Optional human-friendly stage label override. */
  stage_label?: string;
  /** ISO timestamp when the ticket was created. */
  createdate?: string;
  /** ISO timestamp of the last update. */
  hs_lastmodifieddate?: string;
  company_name?: string;
  company_domain?: string;
  /** Number of comments / replies on the ticket. */
  comment_count?: number;
  portal_id?: string;
  preview?: boolean;
  projectId?: string;
}

const previewSample: Required<Pick<Props,
  | "ticket_id" | "subject" | "content" | "hs_ticket_priority"
  | "hs_pipeline_stage" | "createdate" | "hs_lastmodifieddate"
  | "company_name" | "company_domain" | "comment_count" | "portal_id"
>> = {
  ticket_id: "20100",
  subject: "Slow API response times — affecting overnight runs",
  content: "Acme reports API p95 latency above 4s for 10 days. Two follow-ups, no resolution.",
  hs_ticket_priority: "HIGH",
  hs_pipeline_stage: "2",
  createdate: minusHoursISO(240), // ~10 days
  hs_lastmodifieddate: minusHoursISO(36),
  company_name: "Acme Logistics",
  company_domain: "acme-logistics.com",
  comment_count: 4,
  portal_id: "0",
};

export default function TicketCard(props: Props) {
  const p: Props = props.preview ? { ...previewSample, ...props } : props;
  const priority = ticketPriorityMeta(p.hs_ticket_priority);
  const stage = ticketStageMeta(p.hs_pipeline_stage, p.stage_label);
  const url = recordUrl("ticket", p.ticket_id, p.portal_id);

  return (
    <Card>
      <CardHeader
        logo={hubspotLogo}
        title={p.subject || `Ticket ${p.ticket_id}`}
        subtitle={p.company_name}
        status={{ label: priority.label, variant: pillToDot(priority.variant) }}
        action={{ label: "View in HubSpot", href: url }}
      />
      <div className="px-3 py-3 flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill variant={priority.variant}>{priority.label} priority</StatusPill>
          <StatusPill variant={stage.variant}>{stage.label}</StatusPill>
          {p.comment_count !== undefined && p.comment_count > 0 && (
            <span className="text-[10px] text-text-dim">💬 {p.comment_count}</span>
          )}
        </div>

        {p.content && (
          <div className="text-[11px] text-text-muted line-clamp-3 border-l-2 border-border pl-2">
            {p.content}
          </div>
        )}

        <DataList
          items={[
            ...(p.company_name ? [{
              label: "Company",
              value: (
                <span className="inline-flex items-center gap-1.5">
                  {p.company_domain && (
                    <img src={faviconFor(p.company_domain)} alt="" width={12} height={12} className="rounded-sm" />
                  )}
                  <span className="text-text">{p.company_name}</span>
                </span>
              ),
            }] : []),
            ...(p.createdate ? [{ label: "Opened", value: timeAgo(p.createdate) }] : []),
            ...(p.hs_lastmodifieddate ? [{ label: "Updated", value: timeAgo(p.hs_lastmodifieddate) }] : []),
          ]}
        />
      </div>
    </Card>
  );
}
