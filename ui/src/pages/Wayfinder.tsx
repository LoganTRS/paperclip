import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Map as MapIcon, Compass, X, ExternalLink } from "lucide-react";
import { Link } from "@/lib/router";
import { issuesApi, type IssueListFilters } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { IssueStatusBadge } from "../components/StatusBadge";
import type { Issue, IssueRelationIssueSummary } from "@paperclipai/shared";
import { cn } from "../lib/utils";

/**
 * Wayfinder board: lists wayfinding maps and renders each map's decision
 * tickets as a DAG (edges = native `blocks` relations). The frontier — open
 * tickets whose blockers are all done — is highlighted on top so an operator
 * sees what is attackable first.
 *
 * Clicking a ticket (or the map) opens the FULL issue detail page in a
 * same-screen side pane (an iframe on the same origin) so you can read AND
 * answer the ticket — comments, status changes, HITL question cards — without
 * leaving the map or losing your place. No backend, schema, or migration
 * changes: issues.parent_id gives the map→ticket tree, and the issue list
 * already returns blockedBy / blocks per issue.
 */

/**
 * A wayfinding map is an issue carrying the `wayfinder:map` label — the
 * canonical map label the wayfinder skill applies to the map issue (the only
 * label a map and its tickets carry). Detection is label-only on purpose:
 * title/body heuristics (a `... wayfinding map` suffix or a `## Destination`
 * section) over-match ordinary tickets, so the label is the single source of
 * truth. Maps created before the label was applied will not appear here
 * until they are labelled.
 */
export function isWayfindingMap(issue: Issue): boolean {
  if (issue.hiddenAt) return false;
  const labels = issue.labels?.map((label) => label.name.toLowerCase()) ?? [];
  return labels.includes("wayfinder:map");
}

function ticketStatusRank(status: string): number {
  // Done/cancelled sink to the bottom; the frontier (open, unblocked) sits on top.
  if (status === "done") return 3;
  if (status === "cancelled") return 4;
  if (status === "in_review" || status === "in_progress") return 1;
  return 0; // todo / backlog / blocked
}

interface MapGraph {
  map: Issue;
  tickets: Map<string, Issue>;
  edges: Array<{ fromId: string; toId: string }>;
  frontier: Issue[];
  openCount: number;
}

export function buildMapGraph(map: Issue, allIssues: Issue[]): MapGraph {
  const byId = new Map<string, Issue>();
  for (const issue of allIssues) byId.set(issue.id, issue);

  const tickets = new Map<string, Issue>();
  const edges = new Map<string, { fromId: string; toId: string }>();

  for (const issue of allIssues) {
    if (issue.parentId !== map.id) continue;
    tickets.set(issue.id, issue);
    // Native blocking: `blockedBy` on the child are the blocker tickets.
    for (const blocker of issue.blockedBy ?? []) {
      if (!tickets.has(blocker.id) && blocker.id !== map.id) {
        // Blocker outside the map tree (or a locked stub); still a real edge.
        tickets.set(blocker.id, { ...blocker } as unknown as Issue);
      }
      const key = `${blocker.id}->${issue.id}`;
      edges.set(key, { fromId: blocker.id, toId: issue.id });
    }
  }

  // Frontier: open tickets INSIDE the map whose blockers are all done.
  // Blockers outside the map are still tracked as edges, but they never
  // become attackable themselves.
  const frontier: Issue[] = [];
  let openCount = 0;
  for (const ticket of tickets.values()) {
    if (ticket.id === map.id || ticket.hiddenAt) continue;
    const open = ticket.status !== "done" && ticket.status !== "cancelled";
    if (open) openCount += 1;
    if (!open) continue;
    if (ticket.parentId !== map.id) continue;
    const blockers: (IssueRelationIssueSummary | undefined)[] =
      (ticket.blockedBy ?? []).filter((blocker) => tickets.has(blocker.id));
    const unblocked = blockers.every((blocker) => blocker?.status === "done");
    if (unblocked) frontier.push(ticket);
  }
  frontier.sort(
    (a, b) =>
      ticketStatusRank(a.status) - ticketStatusRank(b.status) ||
      (a.identifier ?? "").localeCompare(b.identifier ?? ""),
  );

  return {
    map,
    tickets,
    edges: [...edges.values()],
    frontier,
    openCount,
  };
}

function issueHref(id: string): string {
  return `/issues/${id}`;
}

/**
 * The iframe src for the same-screen ticket pane. Always same-origin (the app's
 * own `/{prefix}/issues/{id}` route) with the `embedded=1` flag so the embedded
 * instance runs on in-memory history + compact chrome (see lib/embedded-mode).
 */
export function issuePaneSrc(prefix: string, issueId: string): string {
  return `/${prefix}/issues/${issueId}?embedded=1`;
}

function EdgeLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-(length:--text-nano) text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-0 w-4 border-t-2 border-dashed border-(--status-task-blocked)" aria-hidden="true" />
        open blocker
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-0 w-4 border-t-2 border-(--status-task-done)" aria-hidden="true" />
        blocker done
      </span>
      <span>edge = blocker → blocked</span>
    </div>
  );
}

function MapDag({
  graph,
  onOpenIssue,
}: {
  graph: MapGraph;
  onOpenIssue: (id: string) => void;
}) {
  const { map, tickets, frontier } = graph;
  const ticketList = [...tickets.values()].filter((ticket) => ticket.id !== map.id);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => onOpenIssue(map.id)}
            className="max-w-full truncate text-left text-(length:--text-compact) font-semibold hover:underline"
            title="Open the map in the side pane"
          >
            {map.identifier ? `${map.identifier} · ` : ""}
            {map.title}
          </button>
          <div className="mt-1 flex items-center gap-2">
            <IssueStatusBadge status={map.status} />
            <span className="text-(length:--text-nano) text-muted-foreground">
              {graph.openCount} open of {ticketList.length} decision tickets
            </span>
          </div>
        </div>
        <EdgeLegend />
      </div>

      <div className="px-4 py-3">
        <h3 className="mb-2 text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
          Frontier — attack these first (all blockers done)
        </h3>
        {frontier.length === 0 ? (
          <p className="text-(length:--text-compact) text-muted-foreground">
            {graph.openCount === 0
              ? "Map is clear: every decision ticket is done or cancelled."
              : "Nothing is attackable right now — every open ticket still has an open blocker."}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {frontier.map((ticket) => (
              <li key={ticket.id}>
                <FrontierCard ticket={ticket} onOpenIssue={onOpenIssue} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border px-4 py-3">
        <h3 className="mb-2 text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
          Dependency graph
        </h3>
        <DependencyGraph
          mapId={map.id}
          tickets={tickets}
          edges={graph.edges}
          onOpenIssue={onOpenIssue}
        />
      </div>
    </div>
  );
}

function FrontierCard({
  ticket,
  onOpenIssue,
}: {
  ticket: Issue;
  onOpenIssue: (id: string) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <button
        type="button"
        onClick={() => onOpenIssue(ticket.id)}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-md border border-(--status-task-done)/40 bg-(--status-task-done)/10 px-3 py-2 text-left transition-colors hover:bg-(--status-task-done)/20"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-(length:--text-compact) font-medium">
            {ticket.identifier ? `${ticket.identifier} · ` : ""}
            {ticket.title}
          </div>
          <div className="mt-1.5">
            <IssueStatusBadge status={ticket.status} />
          </div>
        </div>
        <Compass className="mt-0.5 size-4 shrink-0 text-(--status-task-done)" aria-hidden="true" />
      </button>
      <Link
        to={issueHref(ticket.id)}
        className="flex shrink-0 items-center rounded-md border border-border px-2 text-muted-foreground transition-colors hover:text-foreground"
        aria-label={`Open ${ticket.identifier ?? "ticket"} in a new tab`}
        title="Open in new tab"
      >
        <ExternalLink className="size-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

/**
 * Layered DAG: one column per depth in the blocker graph (roots first). A
 * ticket renders once, in the column equal to its longest blocker-chain
 * depth. Edges are drawn as a compact per-node "blocked by" list with the
 * blocker's state color — green (done) vs dashed (still open) — instead of
 * SVG spaghetti, which keeps the graph legible at board density.
 */
function DependencyGraph({
  mapId,
  tickets,
  edges,
  onOpenIssue,
}: {
  mapId: string;
  tickets: Map<string, Issue>;
  edges: Array<{ fromId: string; toId: string }>;
  onOpenIssue: (id: string) => void;
}) {
  const ticketIds = [...tickets.values()]
    .map((ticket) => ticket.id)
    .filter((id) => id !== mapId);
  if (ticketIds.length === 0) {
    return (
      <p className="text-(length:--text-compact) text-muted-foreground">
        No decision tickets under this map yet.
      </p>
    );
  }

  const blockedBy = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.toId === mapId) continue;
    const list = blockedBy.get(edge.toId) ?? [];
    list.push(edge.fromId);
    blockedBy.set(edge.toId, list);
  }

  // Depth = longest chain of open-or-done blockers above the ticket.
  const depth = new Map<string, number>();
  const resolving = new Set<string>();
  function depthOf(id: string): number {
    if (depth.has(id)) return depth.get(id)!;
    if (resolving.has(id)) return 0; // cycle guard: treat as root
    resolving.add(id);
    const blockers = blockedBy.get(id) ?? [];
    const value =
      blockers.length === 0
        ? 0
        : Math.max(...blockers.map((blockerId) => depthOf(blockerId) + 1));
    resolving.delete(id);
    depth.set(id, value);
    return value;
  }
  for (const id of ticketIds) depthOf(id);

  const columns = new Map<number, string[]>();
  for (const id of ticketIds) {
    const level = depth.get(id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), id]);
  }

  const levels = [...columns.keys()].sort((a, b) => a - b);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {levels.map((level) => (
        <div key={level} className="flex w-56 shrink-0 flex-col gap-2">
          <div className="text-center text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
            {level === 0 ? "Roots" : `Depth ${level}`}
          </div>
          {(columns.get(level) ?? []).map((id) => {
            const ticket = tickets.get(id);
            if (!ticket) return null;
            const blockers = (blockedBy.get(id) ?? [])
              .map((blockerId) => tickets.get(blockerId))
              .filter((blocker): blocker is Issue => blocker !== undefined);
            return (
              <div
                key={id}
                className={cn(
                  "rounded-md border bg-background px-3 py-2",
                  ticket.status === "done"
                    ? "border-(--status-task-done)/40"
                    : "border-border",
                  ticket.status === "cancelled" && "opacity-60",
                )}
              >
                <button
                  type="button"
                  onClick={() => onOpenIssue(id)}
                  className="line-clamp-2 text-left text-(length:--text-compact) font-medium hover:underline"
                >
                  {ticket.identifier ? `${ticket.identifier} · ` : ""}
                  {ticket.title}
                </button>
                <div className="mt-1.5">
                  <IssueStatusBadge status={ticket.status} />
                </div>
                {blockers.length > 0 && (
                  <div className="mt-2 border-t border-dashed border-border pt-1.5">
                    <span className="text-(length:--text-nano) text-muted-foreground">
                      blocked by
                    </span>
                    <ul className="mt-1 space-y-0.5">
                      {blockers.map((blocker) => {
                        const done = blocker.status === "done";
                        return (
                          <li key={blocker.id}>
                            <button
                              type="button"
                              onClick={() => onOpenIssue(blocker.id)}
                              className={cn(
                                "inline-flex max-w-full items-center gap-1.5 text-left text-(length:--text-nano) hover:underline",
                                done
                                  ? "text-(--status-task-done)"
                                  : "text-muted-foreground",
                              )}
                            >
                              <span
                                className={cn(
                                  "inline-block h-0 w-3 shrink-0 border-t-2",
                                  done ? "border-(--status-task-done)" : "border-dashed border-(--status-task-blocked)",
                                )}
                                aria-hidden="true"
                              />
                              <span className="truncate">
                                {blocker.identifier ?? blocker.title}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function Wayfinder() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  // The ticket (or map) opened in the same-screen side pane. Null = pane closed.
  const [openIssueId, setOpenIssueId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Wayfinder" }]);
  }, [setBreadcrumbs]);

  // One bounded read of the whole company issue space (compact view, with the
  // blockedBy projections the graph needs). Wayfinder maps and their tickets
  // are a tiny fraction of a company's issues; the compact list is the same
  // surface the Tasks page already polls.
  const { data: issues, isLoading, error } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "wayfinder",
      "include-blocked-by",
    ],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        includeBlockedBy: true,
        limit: 500,
        offset: 0,
        sortField: "id",
        sortDir: "asc",
      } as IssueListFilters),
    enabled: !!selectedCompanyId,
  });

  const graphs = useMemo(() => {
    const all = issues ?? [];
    // Cancelled maps are historical — they're not a live frontier to attack, so
    // they're excluded from the board (the label alone qualifies an issue as a
    // map; this status filter keeps the chip list to live efforts).
    const maps = all.filter((issue) => isWayfindingMap(issue) && issue.status !== "cancelled");
    return maps
      .map((map) => buildMapGraph(map, all))
      .sort((a, b) => (b.map.updatedAt ?? b.map.createdAt).getTime() - (a.map.updatedAt ?? a.map.createdAt).getTime());
  }, [issues]);

  if (!selectedCompanyId) {
    return <EmptyState icon={MapIcon} message="Select an organization to view wayfinding maps." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const selected = graphs.find((graph) => graph.map.id === selectedMapId);
  const onOpenIssue = (id: string) => setOpenIssueId(id);
  const panePrefix = selectedCompany?.issuePrefix ?? null;
  const paneIssue = openIssueId
    ? [...(issues ?? [])].find((issue) => issue.id === openIssueId) ?? null
    : null;

  return (
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
      <div className="min-w-0 flex-1 space-y-4">
        {error && <p className="text-sm text-destructive">{error.message}</p>}

        {graphs.length === 0 && (
          <EmptyState
            icon={MapIcon}
            message="No wayfinding maps yet. Run /wayfinder on a task to chart one."
          />
        )}

        {graphs.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              {graphs.map((graph) => (
                <button
                  key={graph.map.id}
                  type="button"
                  onClick={() => setSelectedMapId(graph.map.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-1.5 text-(length:--text-compact) transition-colors",
                    (selected ?? graphs[0]).map.id === graph.map.id
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="max-w-60 truncate font-medium">{graph.map.title}</span>
                  {graph.openCount > 0 && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-(length:--text-nano) tabular-nums">
                      {graph.openCount} open
                    </span>
                  )}
                </button>
              ))}
            </div>

            {(selected ?? graphs[0]) ? (
              <MapDag graph={selected ?? graphs[0]} onOpenIssue={onOpenIssue} />
            ) : null}
          </>
        )}
      </div>

      {openIssueId && panePrefix && (
        <IssuePane
          prefix={panePrefix}
          issueId={openIssueId}
          title={paneIssue ? (paneIssue.identifier ? `${paneIssue.identifier} · ` : "") + paneIssue.title : "Ticket"}
          onClose={() => setOpenIssueId(null)}
        />
      )}
    </div>
  );
}

/**
 * Same-screen side pane: renders the FULL issue detail page (the real
 * `/{prefix}/issues/{id}` route) in a same-origin iframe, so an operator can
 * read AND answer the ticket — comments, status changes, HITL question cards —
 * without leaving the Wayfinder map. The `embedded` query param tells the
 * embedded instance to run on in-memory history (no parent-history pollution)
 * and to hide its global nav chrome (see lib/embedded-mode.ts).
 */
function IssuePane({
  prefix,
  issueId,
  title,
  onClose,
}: {
  prefix: string;
  issueId: string;
  title: string;
  onClose: () => void;
}) {
  const src = issuePaneSrc(prefix, issueId);
  return (
    <aside
      className="flex h-dvh min-h-0 w-full shrink-0 flex-col border-l border-border bg-background xl:sticky xl:top-0 xl:h-dvh xl:w-(--pct-62)"
      aria-label="Ticket detail pane"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-(length:--text-compact) font-medium" title={title}>
          {title}
        </span>
        <a
          href={`/issues/${issueId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-(length:--text-nano) text-muted-foreground transition-colors hover:text-foreground"
          title="Open full page in a new tab"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          new tab
        </a>
        <button
          type="button"
          onClick={onClose}
          className="flex shrink-0 items-center rounded-md border border-border px-2 py-1 text-(length:--text-nano) text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Close ticket pane"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 bg-background">
        <iframe
          src={src}
          title={title}
          className="h-full w-full border-0"
          // Same-origin (our own app) — no sandbox attribute, so the embedded
          // page keeps full functionality (forms, navigation, storage).
        />
      </div>
    </aside>
  );
}
