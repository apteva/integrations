// Auto-derived catalog of integration UI components. Adding a new
// vendor or component is two edits: drop the .tsx into src/ui/<vendor>/
// and add an entry here. Could be made fully auto via a Bun import-glob
// later — left explicit for now so we can attach metadata (slots,
// description) per component.

import type { ComponentType } from "react";

import HubspotActivityFeed from "../src/ui/hubspot/ActivityFeed";
import CompanyCard    from "../src/ui/hubspot/CompanyCard";
import ContactCard    from "../src/ui/hubspot/ContactCard";
import ContactList    from "../src/ui/hubspot/ContactList";
import DealCard       from "../src/ui/hubspot/DealCard";
import DealList       from "../src/ui/hubspot/DealList";
import EmailCard      from "../src/ui/hubspot/EmailCard";
import InboxStrip     from "../src/ui/hubspot/InboxStrip";
import PipelineStrip  from "../src/ui/hubspot/PipelineStrip";
import TicketCard     from "../src/ui/hubspot/TicketCard";
import TicketList     from "../src/ui/hubspot/TicketList";

import IssueCard           from "../src/ui/github/IssueCard";
import PullRequestCard     from "../src/ui/github/PullRequestCard";
import WorkflowRunCard     from "../src/ui/github/WorkflowRunCard";
import CommitCard          from "../src/ui/github/CommitCard";
import GithubActivityFeed  from "../src/ui/github/ActivityFeed";

import PageCard            from "../src/ui/notion/PageCard";
import DatabaseCard        from "../src/ui/notion/DatabaseCard";
import DatabaseRowList     from "../src/ui/notion/DatabaseRowList";
import PageList            from "../src/ui/notion/PageList";

// First-party Apteva-app cards. These live in the apps/ monorepo
// (apps/mcp/<slug>/ui/<Component>.tsx) — not under integrations/.
// They use the same ui-kit primitives so they show up uniformly
// in the explorer next to the integration cards.
import FileCard            from "../../apps/mcp/storage/ui/FileCard";

import TableCard           from "../../apps/mcp/tables/ui/TableCard";
import RowCard             from "../../apps/mcp/tables/ui/RowCard";
import TableRowList        from "../../apps/mcp/tables/ui/TableRowList";

export interface CatalogEntry {
  /** Vendor slug — groups components in the explorer sidebar. */
  vendor: string;
  /** Component file name without the .tsx — also the slug used in
   *  demo profiles' `component:` field. */
  name: string;
  /** Human-readable label. */
  label: string;
  /** One-line "what does this card show? " hint. */
  description: string;
  /** Slot tags from the registry — where this component is allowed
   *  to render in a host UI. */
  slots: string[];
  /** The actual component to render. Always called with
   *  `{ preview: true }` in the explorer; the component's own
   *  preview-mode props supply the sample data. */
  component: ComponentType<any>;
  /** Render width hint — some cards (PipelineStrip) want full width,
   *  others (DealCard) look right at ~480px. */
  width?: "full" | "wide" | "default";
}

export const catalog: CatalogEntry[] = [
  {
    vendor: "hubspot",
    name: "PipelineStrip",
    label: "Pipeline strip",
    description: "At-a-glance funnel state — KPI per stage, total weighted value.",
    slots: ["dashboard.tile"],
    component: PipelineStrip,
    width: "full",
  },
  {
    vendor: "hubspot",
    name: "DealCard",
    label: "Deal card",
    description: "Single deal — value, stage, company, owner, close date.",
    slots: ["chat.message_attachment"],
    component: DealCard,
  },
  {
    vendor: "hubspot",
    name: "DealList",
    label: "Deal list",
    description: "Stack of deals (e.g. all open deals for a company).",
    slots: ["dashboard.tile"],
    component: DealList,
    width: "wide",
  },
  {
    vendor: "hubspot",
    name: "TicketCard",
    label: "Ticket card",
    description: "Support ticket — priority, body, opened/updated.",
    slots: ["chat.message_attachment"],
    component: TicketCard,
  },
  {
    vendor: "hubspot",
    name: "TicketList",
    label: "Ticket list",
    description: "Stack of support tickets (open by priority).",
    slots: ["dashboard.tile"],
    component: TicketList,
    width: "wide",
  },
  {
    vendor: "hubspot",
    name: "ContactCard",
    label: "Contact card",
    description: "Single contact — name, email, lifecycle, last contacted.",
    slots: ["chat.message_attachment"],
    component: ContactCard,
  },
  {
    vendor: "hubspot",
    name: "ContactList",
    label: "Contact list",
    description: "Stack of contacts.",
    slots: ["dashboard.tile"],
    component: ContactList,
    width: "wide",
  },
  {
    vendor: "hubspot",
    name: "CompanyCard",
    label: "Company card",
    description: "Single company — domain, industry, employee count.",
    slots: ["chat.message_attachment"],
    component: CompanyCard,
  },
  {
    vendor: "hubspot",
    name: "EmailCard",
    label: "Email card",
    description: "Single email engagement — from/to, subject, body excerpt.",
    slots: ["chat.message_attachment"],
    component: EmailCard,
  },
  {
    vendor: "hubspot",
    name: "InboxStrip",
    label: "Inbox strip",
    description: "Recent inbound emails strip.",
    slots: ["dashboard.tile"],
    component: InboxStrip,
    width: "wide",
  },
  // ── github ──
  {
    vendor: "github",
    name: "PullRequestCard",
    label: "Pull request card",
    description: "Single PR — title, state, branch, reviewers, labels, diff stats.",
    slots: ["chat.message_attachment"],
    component: PullRequestCard,
  },
  {
    vendor: "github",
    name: "IssueCard",
    label: "Issue card",
    description: "Single issue — number, title, state, assignees, labels, comments.",
    slots: ["chat.message_attachment"],
    component: IssueCard,
  },
  {
    vendor: "github",
    name: "WorkflowRunCard",
    label: "Workflow run card",
    description: "Single GitHub Actions run — status, branch, jobs list, duration.",
    slots: ["chat.message_attachment"],
    component: WorkflowRunCard,
    width: "wide",
  },
  {
    vendor: "github",
    name: "CommitCard",
    label: "Commit card",
    description: "Single commit — sha, subject, body, author, file stats.",
    slots: ["chat.message_attachment"],
    component: CommitCard,
  },
  {
    vendor: "github",
    name: "ActivityFeed",
    label: "Activity feed",
    description: "Live repo activity — pushes, PRs, issues, releases, CI runs grouped by day.",
    slots: ["dashboard.tile"],
    component: GithubActivityFeed,
    width: "wide",
  },

  // ── notion ──
  {
    vendor: "notion",
    name: "PageCard",
    label: "Page card",
    description: "Single Notion page — icon, title, breadcrumb, properties (when a database row), excerpt.",
    slots: ["chat.message_attachment"],
    component: PageCard,
  },
  {
    vendor: "notion",
    name: "DatabaseCard",
    label: "Database card",
    description: "Notion database overview — schema pills, item count, views, last edited.",
    slots: ["chat.message_attachment"],
    component: DatabaseCard,
  },
  {
    vendor: "notion",
    name: "DatabaseRowList",
    label: "Database row list",
    description: "Rows from a Notion database query — title, status, owner, due. Most-used Notion tile.",
    slots: ["dashboard.tile", "chat.message_attachment"],
    component: DatabaseRowList,
    width: "wide",
  },
  {
    vendor: "notion",
    name: "PageList",
    label: "Page list",
    description: "Recent or search-result pages — icon, title, breadcrumb, last-edited byline.",
    slots: ["dashboard.tile"],
    component: PageList,
    width: "wide",
  },

  {
    vendor: "hubspot",
    name: "ActivityFeed",
    label: "Activity feed",
    description: "Engagement timeline grouped by day.",
    slots: ["dashboard.tile", "chat.message_attachment"],
    component: HubspotActivityFeed,
    width: "wide",
  },

  // ── storage (first-party Apteva app) ──
  {
    vendor: "storage",
    name: "FileCard",
    label: "File card",
    description: "Single file from the storage app — name, folder, size, type, image/video preview.",
    slots: ["chat.message_attachment"],
    component: FileCard,
  },

  // ── tables (first-party Apteva app — typed-row database) ──
  {
    vendor: "tables",
    name: "TableCard",
    label: "Table card",
    description: "Table overview — schema pills typed by column kind, row count, scope (project/global), created byline.",
    slots: ["chat.message_attachment"],
    component: TableCard,
  },
  {
    vendor: "tables",
    name: "RowCard",
    label: "Row card",
    description: "Single row detail — every field as a typed key/value, status surfaces in the header pill.",
    slots: ["chat.message_attachment"],
    component: RowCard,
  },
  {
    vendor: "tables",
    name: "TableRowList",
    label: "Table row list",
    description: "Query results — id + title + status + summary fields per row. Most-used Tables tile.",
    slots: ["dashboard.tile", "chat.message_attachment"],
    component: TableRowList,
    width: "wide",
  },
];

export const vendors = Array.from(new Set(catalog.map((e) => e.vendor)));
