// ActivityFeed — mixed engagement timeline grouped by day. Replaces
// the demo runner's raw event log with a CRM-shaped view: emails,
// calls, notes, tasks, and record changes side-by-side, color-banded
// by kind.
//
// Caller pre-merges events from HubSpot's per-engagement-type tools
// into a flat list. The component groups by local day.

import type { ComponentType } from "react";
import { Mail, Phone, FileText, CheckSquare, Calendar, RefreshCw } from "lucide-react";
import { Card, CardHeader, Timeline } from "@apteva/ui-kit";
import type { TimelineEvent, TimelineTone } from "@apteva/ui-kit";
import { recordUrl, minusHoursISO, hubspotVendor } from "./lib/hubspot";

type Kind = "email" | "call" | "note" | "task" | "meeting" | "record_change";

interface Event {
  id: string;
  kind: Kind;
  /** ISO timestamp. */
  timestamp: string;
  title: string;
  subtitle?: string;
  /** Engagement id — used to build the canonical link. */
  engagement_id?: string;
}

interface Props {
  events?: Event[];
  /** Cap rendered events; show "+N more" when exceeded. Default 12. */
  max?: number;
  portal_id?: string;
  preview?: boolean;
  projectId?: string;
}

const previewEvents: Event[] = [
  { id: "1", kind: "email",          timestamp: minusHoursISO(2),   title: "Inbound email from Sarah Chen",                subtitle: "Acme · board review tomorrow", engagement_id: "30100" },
  { id: "2", kind: "task",           timestamp: minusHoursISO(2),   title: "Created task: Draft renewal response",         subtitle: "Owner: marc-olivier",          engagement_id: "30101" },
  { id: "3", kind: "note",           timestamp: minusHoursISO(3),   title: "Note added to Acme Q4 Renewal",                subtitle: "Pricing locked at $48k",       engagement_id: "30102" },
  { id: "4", kind: "record_change",  timestamp: minusHoursISO(28),  title: "Deal stage → Contract sent",                   subtitle: "Acme Q4 Renewal · was Decision-maker bought in " },
  { id: "5", kind: "call",           timestamp: minusHoursISO(31),  title: "Call logged with Lisa Rodriguez",              subtitle: "Initech · 12 min",              engagement_id: "30103" },
  { id: "6", kind: "email",          timestamp: minusHoursISO(54),  title: "Outbound email to David Park",                 subtitle: "Globex · pilot follow-up",      engagement_id: "30104" },
];

const KIND_TONE: Record<Kind, TimelineTone> = {
  email:         "info",
  call:          "accent",
  note:          "neutral",
  task:          "warn",
  meeting:       "accent",
  record_change: "neutral",
};

const KIND_ICON: Record<Kind, ComponentType<{ className?: string }>> = {
  email:         Mail,
  call:          Phone,
  note:          FileText,
  task:          CheckSquare,
  meeting:       Calendar,
  record_change: RefreshCw,
};

export default function ActivityFeed(props: Props) {
  const evts = props.preview ? (props.events ?? previewEvents) : (props.events ?? []);
  const max = props.max ?? 12;

  const timelineEvents: TimelineEvent[] = evts.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    tone: KIND_TONE[e.kind],
    icon: (() => { const Ico = KIND_ICON[e.kind]; return <Ico className="w-3.5 h-3.5" />; })(),
    title: e.title,
    subtitle: e.subtitle,
    href: e.engagement_id ? recordUrl("engagement", e.engagement_id, props.portal_id) : undefined,
  }));

  return (
    <Card fullWidth>
      <CardHeader
        vendor={hubspotVendor}
        title="Recent CRM activity"
        subtitle={evts.length > 0 ? `${evts.length} event${evts.length === 1 ? "" : "s"}` : "Quiet"}
      />
      <Timeline events={timelineEvents} max={max} emptyLabel="No CRM activity yet." />
    </Card>
  );
}
