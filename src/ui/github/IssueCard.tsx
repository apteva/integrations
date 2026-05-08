// IssueCard — chat-attachment card for a single GitHub issue.
//
// The agent calls
// respond(components=[{ app: "github", name: "issue-card", props:{...}}])
// and this card mounts under the agent's message bubble.
//
// v1 renders from inline props — the agent passes what it just got
// back from the github get_issue tool. A future revision can add a
// component-side fetch path so the card live-updates without the
// agent having to re-render. Until that exists, props ARE the
// source of truth.
//
// Visuals are entirely composed from @apteva/ui-kit primitives so the
// card looks like every other chat-attachment in the platform.

import { MessageCircle } from "lucide-react";
import { Card, CardHeader, StatusPill, Avatar, DataList } from "@apteva/ui-kit";
import { githubVendor } from "./lib/github";

interface User {
 login: string;
 avatar_url: string;
}

interface Label {
 name: string;
 color: string;
}

interface Issue {
 number: number;
 title: string;
 state: "open" |"closed";
 state_reason?:"completed" |"not_planned" |"reopened" | null;
 user: User;
 assignees?: User[];
 labels?: Label[];
 comments: number;
 html_url: string;
 body?: string | null;
}

interface Props {
 /**"owner/name" — required. */
 repo: string;
 /** GitHub issue number (#NN), required. */
 issue_number: number;
 /** Issue title — agent passes from get_issue response. */
 title?: string;
 /** Issue state —"open" or"closed". */
 state?:"open" |"closed";
 state_reason?:"completed" |"not_planned" |"reopened" | null;
 /** Author login (the user who opened the issue). */
 user_login?: string;
 /** Author avatar URL. */
 user_avatar_url?: string;
 /** Comma-separated label names. Optional convenience for terse
 * agent calls; richer apps can pass `labels` directly. */
 labels?: string;
 /** Comma-separated assignee logins. */
 assignees?: string;
 /** Comments count. */
 comments?: number;
 /** Soft preview convention — render synthetic data when no real
 * data is available so the dashboard's app detail panel can show
 * what the card looks like even before the user creates a
 * connection. */
 preview?: boolean;
 /** Injected by the host (unused in v1, here for the future fetch
 * path). */
 projectId?: string;
}

const previewSample: Issue = {
 number: 1234,
 title: "Retry tier escalation skips dunning step on past-due renewals",
 state: "open",
 state_reason: null,
 user: {
 login: "maya",
 avatar_url: "data:image/svg+xml;utf8," +
 encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='8' fill='%23a78bfa'/></svg>",
 ),
 },
 assignees: [
 {
 login: "ari",
 avatar_url: "data:image/svg+xml;utf8," +
 encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='8' fill='%2334d399'/></svg>",
 ),
 },
 ],
 labels: [
 { name: "billing", color: "1f6feb" },
 { name: "bug", color: "d73a4a" },
 ],
 comments: 7,
 html_url: "https://github.com/acme/api/issues/1234",
};

// Stable color palette for labels we don't get a hex from. Hashes
// the label name into one of a small fixed set so the same label
// always renders the same color across cards.
const labelPalette = ["1f6feb","8957e5","d73a4a","fbca04","0e8a16","5319e7","b60205","0075ca"];
function defaultLabelColor(name: string): string {
 let h = 0;
 for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
 return labelPalette[h % labelPalette.length];
}

function pillForState(issue: Issue): { label: string; variant:"success" |"info" |"error" |"neutral" } {
 if (issue.state === "closed") {
 if (issue.state_reason === "not_planned") return { label: "closed (not planned)", variant: "neutral" };
 return { label: "closed", variant: "success" };
 }
 return { label: "open", variant: "info" };
}

export default function IssueCard(props: Props) {
 const issue: Issue = props.preview
 ? previewSample
 : {
 number: props.issue_number,
 title: props.title || `Issue #${props.issue_number}`,
 state: props.state || "open",
 state_reason: props.state_reason || null,
 user: {
 login: props.user_login || "",
 avatar_url: props.user_avatar_url || "",
 },
 assignees: (props.assignees || "")
 .split(",")
 .map((s) => s.trim())
 .filter(Boolean)
 .map((login) => ({ login, avatar_url: "" })),
 labels: (props.labels || "")
 .split(",")
 .map((s) => s.trim())
 .filter(Boolean)
 .map((name) => ({ name, color: defaultLabelColor(name) })),
 comments: typeof props.comments === "number" ? props.comments : 0,
 html_url: `https://github.com/${props.repo}/issues/${props.issue_number}`,
 };

 const pill = pillForState(issue);
 const url = issue.html_url;
 const repo = props.repo;

 return (
 <Card>
 <CardHeader
 vendor={githubVendor}
 title={repo}
 subtitle={`#${issue.number} · ${issue.title}`}
 status={{ label: pill.label, variant: pill.variant === "info" ? "active" : pill.variant === "success" ? "live" :"muted" }}
 action={{ label: "View on GitHub", href: url }}
 />
 <div className="px-3 py-3 flex flex-col gap-3">
 <div className="flex items-center gap-2 text-xs text-text-muted">
 <Avatar src={issue.user.avatar_url} name={issue.user.login} size={16} />
 <span className="text-text">{issue.user.login}</span>
 <span className="text-text-dim">opened this issue</span>
 <span className="ml-auto inline-flex items-center gap-1">
 <MessageCircle className="w-3.5 h-3.5 text-text-dim" />
 <span className="text-text-muted">{issue.comments}</span>
 </span>
 </div>
 <DataList
 items={[
 { label: "Status", value: <StatusPill variant={pill.variant}>{pill.label}</StatusPill> },
 ...(issue.labels && issue.labels.length > 0
 ? [
 {
 label: "Labels",
 value: (
 <span className="flex flex-wrap gap-1">
 {issue.labels.map((l) => (
 <span
 key={l.name}
 className="px-1.5 py-0.5 rounded text-[11px] font-medium"
 style={{ backgroundColor: `#${l.color}33`, color: `#${l.color}` }}
 >
 {l.name}
 </span>
 ))}
 </span>
 ),
 },
 ]
 : []),
 ...(issue.assignees && issue.assignees.length > 0
 ? [
 {
 label: "Assignees",
 value: (
 <span className="inline-flex items-center gap-1">
 {issue.assignees.map((a) => (
 <span key={a.login} className="inline-flex items-center gap-1 text-xs text-text">
 <Avatar src={a.avatar_url} name={a.login} size={12} />
 {a.login}
 </span>
 ))}
 </span>
 ),
 },
 ]
 : []),
 ]}
 />
 </div>
 </Card>
 );
}
