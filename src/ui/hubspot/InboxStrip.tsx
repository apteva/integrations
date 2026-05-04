// InboxStrip — compact unread-feed of recent emails. Same shape as
// EmailCard items[] but flattened into one-line rows with a snippet.
// Used in the dashboard tile and the demo runner's kiosk header.

import { Card, CardHeader, Avatar, Row, StatusPill } from "@apteva/ui-kit";
import { recordUrl, timeAgo, minusHoursISO, hubspotLogo } from "./lib/hubspot";

interface InboxItem {
  email_id: string;
  from_name?: string;
  from_email?: string;
  subject?: string;
  /** First line of the body — caller pre-trims. */
  snippet?: string;
  sent_at?: string;
  unread?: boolean;
  thread_length?: number;
}

interface Props {
  items?: InboxItem[];
  title?: string;
  subtitle?: string;
  max_rows?: number;
  portal_id?: string;
  preview?: boolean;
  projectId?: string;
}

const previewItems: InboxItem[] = [
  { email_id: "1", from_name: "Sarah Chen",      from_email: "sarah.chen@acme-logistics.com",     subject: "Third time I'm asking — board review tomorrow", snippet: "We're 36 hours away from our board review.", sent_at: minusHoursISO(2),  unread: true, thread_length: 3 },
  { email_id: "2", from_name: "David Park",      from_email: "david.park@globex-innovations.com", subject: "Globex pilot — push to next quarter",            snippet: "We've had to deprioritize new initiatives…", sent_at: minusHoursISO(28), unread: true },
  { email_id: "3", from_name: "Lisa Rodriguez",  from_email: "lisa.rodriguez@initech-corp.com",   subject: "Re: Pricing — final ask before committee",       snippet: "Three different per-seat numbers from your team.", sent_at: minusHoursISO(6),  unread: true, thread_length: 5 },
  { email_id: "4", from_name: "HubSpot",         from_email: "no-reply@hubspot.com",              subject: "Weekly digest: 3 new opportunities",             snippet: "Your pipeline summary for this week.",         sent_at: minusHoursISO(80) },
];

export default function InboxStrip(props: Props) {
  const items = props.preview ? (props.items ?? previewItems) : (props.items ?? []);
  const max = props.max_rows ?? 6;
  const visible = items.slice(0, max);
  const overflow = items.length - visible.length;
  const unreadCount = items.filter((i) => i.unread).length;

  return (
    <Card>
      <CardHeader
        logo={hubspotLogo}
        title={props.title || "Inbox"}
        subtitle={props.subtitle || (unreadCount > 0 ? `${unreadCount} unread` : `${items.length} message${items.length === 1 ? "" : "s"}`)}
      />
      {visible.length === 0 && (
        <div className="px-3 py-3 text-[11px] text-text-dim">Inbox is quiet.</div>
      )}
      {visible.map((it, i) => (
        <Row
          key={it.email_id}
          flush={i === 0}
          href={recordUrl("engagement", it.email_id, props.portal_id)}
          leading={
            <span className="relative">
              <Avatar src="" name={it.from_name || it.from_email || "?"} size={20} />
              {it.unread && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent ring-1 ring-bg-card" aria-label="unread" />
              )}
            </span>
          }
          title={
            <span className={it.unread ? "font-semibold" : undefined}>
              {it.from_name || it.from_email}
              {it.subject && <span className="text-text-dim font-normal"> · {it.subject}</span>}
            </span>
          }
          subtitle={it.snippet}
          trailing={
            <span className="inline-flex items-center gap-1.5">
              {it.thread_length && it.thread_length > 1 && (
                <StatusPill variant="info">{it.thread_length}</StatusPill>
              )}
              <span className="text-text-dim tabular-nums">{timeAgo(it.sent_at)}</span>
            </span>
          }
        />
      ))}
      {overflow > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-text-dim border-t border-border">
          +{overflow} more
        </div>
      )}
    </Card>
  );
}
