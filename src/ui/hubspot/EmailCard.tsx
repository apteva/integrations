// EmailCard — single inbound/outbound email engagement. The card the
// email-monitor demo's chat surface attaches whenever the agent
// processes an inbound message. Sender identity, subject, snippet,
// thread length, associated record chips.

import { Card, CardHeader, Avatar, StatusPill } from "@apteva/ui-kit";
import { recordUrl, faviconFor, timeAgo, minusHoursISO, hubspotLogo } from "./lib/hubspot";

interface Props {
  /** Engagement id. */
  email_id: string;
  direction?: "INCOMING_EMAIL" | "EMAIL" | "FORWARDED_EMAIL";
  from_name?: string;
  from_email?: string;
  to_email?: string;
  subject?: string;
  /** Plain-text body — first 240 chars rendered as snippet. */
  body?: string;
  /** ISO timestamp the email was received / sent. */
  sent_at?: string;
  /** Length of the thread this message belongs to (1 if standalone). */
  thread_length?: number;
  /** Associated company / contact name for the chip strip. */
  company_name?: string;
  company_domain?: string;
  contact_name?: string;
  portal_id?: string;
  preview?: boolean;
  projectId?: string;
}

const previewSample: Required<Pick<Props,
  | "email_id" | "direction" | "from_name" | "from_email" | "to_email"
  | "subject" | "body" | "sent_at" | "thread_length"
  | "company_name" | "company_domain" | "contact_name" | "portal_id"
>> = {
  email_id: "30100",
  direction: "INCOMING_EMAIL",
  from_name: "Sarah Chen",
  from_email: "sarah.chen@acme-logistics.com",
  to_email: "marc-olivier@apteva.local",
  subject: "This is the third time I'm asking — board review tomorrow",
  body: "Marco,\n\nWe're 36 hours away from our board review. The API performance issue is now in the deck. I have not heard a thing back since you said the team was on it five days ago. If we don't have a concrete fix or a written plan by EOD, I'm pulling the renewal off the agenda…",
  sent_at: minusHoursISO(2),
  thread_length: 3,
  company_name: "Acme Logistics",
  company_domain: "acme-logistics.com",
  contact_name: "Sarah Chen",
  portal_id: "0",
};

function snippet(body: string | undefined, n = 240): string {
  if (!body) return "";
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

export default function EmailCard(props: Props) {
  const p: Props = props.preview ? { ...previewSample, ...props } : props;
  const url = recordUrl("engagement", p.email_id, p.portal_id);
  const incoming = p.direction === "INCOMING_EMAIL" || p.direction === "FORWARDED_EMAIL";
  const dirLabel = incoming ? "Incoming" : "Sent";

  return (
    <Card>
      <CardHeader
        logo={hubspotLogo}
        title={p.subject || "(no subject)"}
        subtitle={p.from_email && p.to_email ? `${p.from_email} → ${p.to_email}` : (p.from_email || p.to_email)}
        status={{ label: dirLabel, variant: incoming ? "active" : "muted" }}
        action={{ label: "View in HubSpot", href: url }}
      />
      <div className="px-3 py-3 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Avatar src="" name={p.from_name || p.from_email || "?"} size={28} />
          <div className="min-w-0 flex-1">
            <div className="text-text text-xs font-medium truncate">{p.from_name || p.from_email}</div>
            {p.from_name && p.from_email && (
              <div className="text-text-dim text-[10px] truncate">{p.from_email}</div>
            )}
          </div>
          <span className="text-[10px] text-text-dim tabular-nums">{timeAgo(p.sent_at)}</span>
        </div>

        {p.body && (
          <p className="text-[11px] text-text-muted line-clamp-4 border-l-2 border-border pl-2 whitespace-pre-line">
            {snippet(p.body)}
          </p>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {p.thread_length && p.thread_length > 1 && (
            <StatusPill variant="info">Thread of {p.thread_length}</StatusPill>
          )}
          {p.company_name && (
            <span className="inline-flex items-center gap-1 text-[10px] text-text-muted bg-bg-input px-1.5 py-0.5 rounded">
              {p.company_domain && (
                <img src={faviconFor(p.company_domain, 16)} alt="" width={10} height={10} className="rounded-sm" />
              )}
              {p.company_name}
            </span>
          )}
          {p.contact_name && (
            <span className="inline-flex items-center gap-1 text-[10px] text-text-muted bg-bg-input px-1.5 py-0.5 rounded">
              {p.contact_name}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
