import { useEffect, useState, useCallback } from "react";
import {
  api,
  type DashboardData,
  type Commitment,
  type CommitmentStatus,
  type CommitmentHorizon,
} from "./api";

const fmtDate = (s: string | null): string => {
  if (!s) return "—";
  return s;
};

const fmtRelativeTime = (ts: number): string => {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const STATUS_COLORS: Record<CommitmentStatus, string> = {
  open: "bg-stone-700 text-stone-200",
  "in-progress": "bg-blue-900 text-blue-200",
  blocked: "bg-amber-900 text-amber-200",
  done: "bg-emerald-900 text-emerald-200",
  dropped: "bg-stone-800 text-stone-500",
};

const KANBAN_COLUMNS: Array<{ key: CommitmentHorizon | "done"; label: string }> = [
  { key: "today", label: "Today" },
  { key: "this-week", label: "This Week" },
  { key: "later", label: "Later" },
  { key: "done", label: "Done" },
];

interface Props {
  onOpenChat: () => void;
}

export default function Dashboard({ onOpenChat }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"company" | "personal">("personal");
  const [pendingChange, setPendingChange] = useState<{
    token: string;
    description: string;
  } | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newDraft, setNewDraft] = useState<Partial<Commitment>>({
    title: "",
    horizon: "today",
    status: "open",
    deadline: null,
    notes: "",
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    const r = await api.dashboard();
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else {
      setError(`${r.status}: ${r.error}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-stone-500 text-sm">
        Loading dashboard…
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-amber-400 text-sm">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const ownerKey = data.signed_in_as.owner_key;
  const visibleCommitments =
    view === "personal"
      ? data.commitments.filter((c) => c.owner === ownerKey)
      : data.commitments;

  const grouped: Record<string, Commitment[]> = {
    today: [],
    "this-week": [],
    later: [],
    done: [],
  };
  for (const c of visibleCommitments) {
    if (c.status === "done") {
      grouped.done.push(c);
    } else if (c.status === "dropped") {
      // Dropped items stay in the file but don't show on the board
      continue;
    } else {
      grouped[c.horizon].push(c);
    }
  }
  // Sort: deadline ascending (no deadline last), then created descending
  const sortFn = (a: Commitment, b: Commitment): number => {
    if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
    if (a.deadline && !b.deadline) return -1;
    if (!a.deadline && b.deadline) return 1;
    return b.created.localeCompare(a.created);
  };
  for (const k of Object.keys(grouped)) grouped[k].sort(sortFn);

  const proposeChange = async (
    id: string,
    field: keyof Commitment,
    newValue: string | null,
    description: string
  ) => {
    const r = await api.commitments.propose({
      change: { id, field, new_value: newValue },
    });
    if (r.ok) {
      setPendingChange({ token: r.data.token, description });
    }
  };

  const proposeNew = async () => {
    if (!newDraft.title || newDraft.title.trim().length === 0) return;
    const r = await api.commitments.propose({
      new_commitment: {
        ...newDraft,
        owner: newDraft.owner || ownerKey,
      },
    });
    if (r.ok) {
      setPendingChange({
        token: r.data.token,
        description: `Add new commitment: "${newDraft.title}"`,
      });
      setShowNewModal(false);
      setNewDraft({
        title: "",
        horizon: "today",
        status: "open",
        deadline: null,
        notes: "",
      });
    }
  };

  const confirmChange = async () => {
    if (!pendingChange) return;
    const r = await api.commitments.confirm(pendingChange.token);
    if (r.ok) {
      setPendingChange(null);
      refresh();
    }
  };

  const m = data.metrics;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="min-h-screen p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <div className="text-xs text-stone-500 mt-1">
            {data.signed_in_as.name} · {data.signed_in_as.email} · {today}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border border-stone-800 rounded overflow-hidden text-sm">
            <button
              onClick={() => setView("personal")}
              className={`px-3 py-1.5 ${
                view === "personal"
                  ? "bg-stone-100 text-stone-950"
                  : "text-stone-400 hover:bg-stone-900"
              }`}
            >
              My view
            </button>
            <button
              onClick={() => setView("company")}
              className={`px-3 py-1.5 ${
                view === "company"
                  ? "bg-stone-100 text-stone-950"
                  : "text-stone-400 hover:bg-stone-900"
              }`}
            >
              Company
            </button>
          </div>
          <button
            onClick={() => setShowNewModal(true)}
            className="px-3 py-1.5 bg-stone-900 hover:bg-stone-800 border border-stone-700 rounded text-sm"
          >
            + New commitment
          </button>
          <button
            onClick={onOpenChat}
            className="px-3 py-1.5 bg-stone-900 hover:bg-stone-800 border border-stone-700 rounded text-sm"
          >
            Chat ↗
          </button>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <MetricCard label="Open" value={m.open_count} />
        <MetricCard label="In progress" value={m.in_progress_count} />
        <MetricCard
          label="Blocked"
          value={m.blocked_count}
          highlight={m.blocked_count > 0 ? "amber" : undefined}
        />
        <MetricCard
          label="Slipping"
          value={m.slipping_count}
          highlight={m.slipping_count > 0 ? "red" : undefined}
        />
        <MetricCard label="Done this week" value={m.done_this_week} />
        <MetricCard label="Commits 7d" value={m.commits_past_7_days} />
        <MetricCard
          label="Days since state"
          value={m.days_since_last_state_file ?? "—"}
          highlight={
            m.days_since_last_state_file !== null && m.days_since_last_state_file > 7
              ? "amber"
              : undefined
          }
        />
      </div>

      {/* Kanban */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {KANBAN_COLUMNS.map((col) => (
          <div
            key={col.key}
            className="bg-stone-950 border border-stone-800 rounded-lg p-3 min-h-[200px]"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs uppercase tracking-wide text-stone-500 font-medium">
                {col.label}
              </div>
              <div className="text-xs text-stone-600">
                {grouped[col.key].length}
              </div>
            </div>
            <div className="space-y-2">
              {grouped[col.key].length === 0 && (
                <div className="text-xs text-stone-700 italic">empty</div>
              )}
              {grouped[col.key].map((c) => (
                <CommitmentCard
                  key={c.id}
                  commitment={c}
                  view={view}
                  today={today}
                  onChangeStatus={(s) =>
                    proposeChange(
                      c.id,
                      "status",
                      s,
                      `${c.id}: status → ${s}`
                    )
                  }
                  onChangeHorizon={(h) =>
                    proposeChange(
                      c.id,
                      "horizon",
                      h,
                      `${c.id}: horizon → ${h}`
                    )
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Panel title="Recent commits (7d)">
          {data.recent_commits.length === 0 ? (
            <div className="text-xs text-stone-600 italic">none</div>
          ) : (
            <div className="space-y-1.5 text-xs text-stone-300 font-mono">
              {data.recent_commits.slice(0, 12).map((line, i) => (
                <div key={i} className="truncate">
                  {line}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Recent brain threads">
          {data.recent_threads.length === 0 ? (
            <div className="text-xs text-stone-600 italic">none</div>
          ) : (
            <div className="space-y-2">
              {data.recent_threads.map((t) => (
                <div key={t.id} className="text-xs">
                  <div className="text-stone-300 line-clamp-2">{t.title}</div>
                  <div className="text-stone-600 mt-0.5">
                    {t.created_by_name.split(" ")[0]} ·{" "}
                    {fmtRelativeTime(t.updated_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={`Inbox (${data.inbox_preview.today_count} today)`}>
          <pre className="text-xs text-stone-400 whitespace-pre-wrap font-mono leading-relaxed">
            {data.inbox_preview.raw_excerpt || "(empty)"}
          </pre>
        </Panel>

        <Panel
          title={`Most recent state file${
            data.weekly_state_preview.most_recent_path
              ? ` — ${data.weekly_state_preview.most_recent_path.split("/").pop()}`
              : ""
          }`}
          colSpan={2}
        >
          <pre className="text-xs text-stone-400 whitespace-pre-wrap leading-relaxed">
            {data.weekly_state_preview.most_recent_excerpt}
          </pre>
        </Panel>
      </div>

      {/* Confirm modal */}
      {pendingChange && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-stone-950 border border-amber-700 rounded-lg p-5 max-w-md w-full">
            <div className="text-xs uppercase tracking-wide text-amber-400 mb-2">
              Proposed change — review before committing
            </div>
            <div className="text-sm text-stone-200 mb-4 break-words">
              {pendingChange.description}
            </div>
            <div className="text-xs text-stone-500 mb-4">
              Will commit to{" "}
              <span className="font-mono">docs/state/commitments.md</span> in
              the substrate repo.
            </div>
            <div className="flex gap-2">
              <button
                onClick={confirmChange}
                className="px-3 py-1.5 bg-amber-500 text-stone-950 rounded text-sm font-medium"
              >
                Confirm and commit
              </button>
              <button
                onClick={() => setPendingChange(null)}
                className="px-3 py-1.5 text-stone-400 text-sm hover:text-stone-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New commitment modal */}
      {showNewModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-stone-950 border border-stone-700 rounded-lg p-5 max-w-md w-full space-y-3">
            <div className="text-sm font-medium text-stone-200">
              New commitment
            </div>
            <div>
              <label className="text-xs text-stone-500">Title</label>
              <input
                value={newDraft.title || ""}
                onChange={(e) =>
                  setNewDraft({ ...newDraft, title: e.target.value })
                }
                className="w-full bg-stone-900 border border-stone-700 rounded px-2 py-1.5 text-sm mt-1"
                placeholder="e.g. Talk to Matthew about May 31 milestone"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-stone-500">Owner</label>
                <select
                  value={newDraft.owner || ownerKey}
                  onChange={(e) =>
                    setNewDraft({ ...newDraft, owner: e.target.value })
                  }
                  className="w-full bg-stone-900 border border-stone-700 rounded px-2 py-1.5 text-sm mt-1"
                >
                  <option value="troy">troy</option>
                  <option value="matthew">matthew</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-stone-500">Horizon</label>
                <select
                  value={newDraft.horizon || "today"}
                  onChange={(e) =>
                    setNewDraft({
                      ...newDraft,
                      horizon: e.target.value as CommitmentHorizon,
                    })
                  }
                  className="w-full bg-stone-900 border border-stone-700 rounded px-2 py-1.5 text-sm mt-1"
                >
                  <option value="today">Today</option>
                  <option value="this-week">This Week</option>
                  <option value="later">Later</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-stone-500">Deadline (optional)</label>
              <input
                type="date"
                value={newDraft.deadline || ""}
                onChange={(e) =>
                  setNewDraft({
                    ...newDraft,
                    deadline: e.target.value || null,
                  })
                }
                className="w-full bg-stone-900 border border-stone-700 rounded px-2 py-1.5 text-sm mt-1"
              />
            </div>
            <div>
              <label className="text-xs text-stone-500">Notes (optional)</label>
              <textarea
                value={newDraft.notes || ""}
                onChange={(e) =>
                  setNewDraft({ ...newDraft, notes: e.target.value })
                }
                className="w-full bg-stone-900 border border-stone-700 rounded px-2 py-1.5 text-sm mt-1"
                rows={2}
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={proposeNew}
                disabled={!newDraft.title?.trim()}
                className="px-3 py-1.5 bg-stone-100 text-stone-950 rounded text-sm font-medium disabled:opacity-50"
              >
                Propose
              </button>
              <button
                onClick={() => setShowNewModal(false)}
                className="px-3 py-1.5 text-stone-400 text-sm hover:text-stone-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface MetricCardProps {
  label: string;
  value: number | string;
  highlight?: "amber" | "red";
}

function MetricCard({ label, value, highlight }: MetricCardProps) {
  const colorClass =
    highlight === "red"
      ? "border-red-700/60"
      : highlight === "amber"
        ? "border-amber-700/60"
        : "border-stone-800";
  return (
    <div className={`bg-stone-950 border ${colorClass} rounded-lg p-3`}>
      <div className="text-xs uppercase tracking-wide text-stone-500">
        {label}
      </div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
    </div>
  );
}

interface CommitmentCardProps {
  commitment: Commitment;
  view: "personal" | "company";
  today: string;
  onChangeStatus: (s: CommitmentStatus) => void;
  onChangeHorizon: (h: CommitmentHorizon) => void;
}

function CommitmentCard({
  commitment: c,
  view,
  today,
  onChangeStatus,
  onChangeHorizon,
}: CommitmentCardProps) {
  const slipping =
    c.deadline &&
    c.deadline < today &&
    c.status !== "done" &&
    c.status !== "dropped";
  return (
    <div
      className={`bg-stone-900 border rounded p-2.5 text-xs ${
        slipping ? "border-red-800" : "border-stone-800"
      }`}
    >
      <div className="text-stone-200 font-medium leading-snug">{c.title}</div>
      <div className="flex items-center justify-between mt-2 gap-2 text-[10px] text-stone-500">
        {view === "company" && (
          <span className="capitalize">{c.owner}</span>
        )}
        <span>
          {c.deadline ? (
            <span className={slipping ? "text-red-400" : ""}>
              due {fmtDate(c.deadline)}
            </span>
          ) : (
            "no deadline"
          )}
        </span>
      </div>
      <div className="flex items-center gap-1 mt-2 flex-wrap">
        <select
          value={c.status}
          onChange={(e) => onChangeStatus(e.target.value as CommitmentStatus)}
          className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLORS[c.status]}`}
        >
          <option value="open">open</option>
          <option value="in-progress">in-progress</option>
          <option value="blocked">blocked</option>
          <option value="done">done</option>
          <option value="dropped">dropped</option>
        </select>
        {c.status !== "done" && c.status !== "dropped" && (
          <select
            value={c.horizon}
            onChange={(e) =>
              onChangeHorizon(e.target.value as CommitmentHorizon)
            }
            className="text-[10px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-400"
          >
            <option value="today">today</option>
            <option value="this-week">this week</option>
            <option value="later">later</option>
          </select>
        )}
      </div>
      {c.notes && (
        <div className="text-[10px] text-stone-500 mt-2 leading-snug line-clamp-2">
          {c.notes}
        </div>
      )}
    </div>
  );
}

interface PanelProps {
  title: string;
  children: React.ReactNode;
  colSpan?: number;
}

function Panel({ title, children, colSpan }: PanelProps) {
  const span = colSpan === 2 ? "lg:col-span-2" : "";
  return (
    <div
      className={`bg-stone-950 border border-stone-800 rounded-lg p-4 ${span}`}
    >
      <div className="text-xs uppercase tracking-wide text-stone-500 mb-3">
        {title}
      </div>
      <div className="max-h-64 overflow-y-auto">{children}</div>
    </div>
  );
}
