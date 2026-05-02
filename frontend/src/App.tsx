import { useEffect, useState, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  type User,
  type ThreadSummary,
  type PendingProposal,
} from "./api";
import Dashboard from "./Dashboard";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
}

interface InboxProposal {
  kind: "inbox";
  token: string;
  line: string;
  expires_at: number;
}

interface CommitmentBannerProposal {
  kind: "commitment";
  token: string;
  proposalKind: "commitment-create" | "commitment-update";
  description: string;
  expires_at: number;
}

type BannerProposal = InboxProposal | CommitmentBannerProposal;

const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

type View = "dashboard" | "chat";

const initialView = (): View => {
  if (typeof window === "undefined") return "dashboard";
  return window.location.pathname === "/chat" ? "chat" : "dashboard";
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [view, setView] = useState<View>(initialView());

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [banners, setBanners] = useState<BannerProposal[]>([]);
  const [inboxEdit, setInboxEdit] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auth check on mount
  useEffect(() => {
    api.me().then((r) => {
      if (r.ok) setUser(r.data.user);
      setAuthChecked(true);
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const path = view === "chat" ? "/chat" : "/";
    if (window.location.pathname !== path) {
      window.history.replaceState({}, "", path);
    }
  }, [view]);

  useEffect(() => {
    const onPop = () => setView(initialView());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const refreshThreads = useCallback(async () => {
    const r = await api.threads.list(30);
    if (r.ok) setThreads(r.data.threads);
  }, []);

  useEffect(() => {
    if (user && view === "chat") refreshThreads();
  }, [user, view, refreshThreads]);

  useEffect(() => {
    if (loadingThread) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loadingThread]);

  const startNewThread = () => {
    setCurrentThreadId(null);
    setMessages([]);
    setInput("");
    setBanners([]);
  };

  const loadThread = async (threadId: string) => {
    if (threadId === currentThreadId) return;
    setLoadingThread(true);
    const r = await api.threads.get(threadId);
    if (r.ok) {
      setCurrentThreadId(threadId);
      setMessages(
        r.data.turns.map((t) => ({
          role: t.role,
          content: t.content,
          ts: t.ts,
        }))
      );
      setBanners([]);
    }
    setLoadingThread(false);
    setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, 50);
  };

  const submit = async () => {
    if (!input.trim() || loading) return;
    const question = input.trim();
    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question, ts: Date.now() },
    ]);
    setLoading(true);

    const r = await api.query(question, currentThreadId ?? undefined);
    setLoading(false);
    if (r.ok) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: r.data.answer, ts: Date.now() },
      ]);
      setCurrentThreadId(r.data.thread_id);
      // Surface any commitment proposals the brain staged via tools
      if (r.data.pending_proposals && r.data.pending_proposals.length > 0) {
        const newBanners: CommitmentBannerProposal[] = r.data.pending_proposals.map(
          (p: PendingProposal) => ({
            kind: "commitment",
            token: p.token,
            proposalKind: p.kind,
            description: p.description,
            expires_at: Date.now() + p.expires_in * 1000,
          })
        );
        setBanners((prev) => [...prev, ...newBanners]);
      }
      refreshThreads();
    } else {
      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: `Error (${r.status}): ${r.error}`,
          ts: Date.now(),
        },
      ]);
    }
  };

  const proposeInbox = async (intent: string) => {
    const r = await api.proposeInbox(intent);
    if (r.ok) {
      setBanners((prev) => [
        ...prev,
        {
          kind: "inbox",
          token: r.data.token,
          line: r.data.proposal.line,
          expires_at: Date.now() + r.data.expires_in * 1000,
        },
      ]);
      setInboxEdit(r.data.proposal.line);
    }
  };

  const confirmBanner = async (b: BannerProposal) => {
    if (b.kind === "inbox") {
      const r = await api.confirmInbox(b.token, inboxEdit);
      if (r.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `✓ Added to inbox: "${r.data.committed}". [View commit](${r.data.commit_url})`,
            ts: Date.now(),
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Inbox add failed: ${r.error}`,
            ts: Date.now(),
          },
        ]);
      }
    } else {
      const r = await api.commitments.confirm(b.token);
      if (r.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `✓ Committed: ${b.description}. [View commit](${r.data.commit_url})`,
            ts: Date.now(),
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "system",
            content: `Commitment update failed: ${r.error}`,
            ts: Date.now(),
          },
        ]);
      }
    }
    dismissBanner(b);
  };

  const dismissBanner = (b: BannerProposal) => {
    setBanners((prev) => prev.filter((x) => x.token !== b.token));
    if (b.kind === "inbox") setInboxEdit("");
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center text-stone-400">
        …
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
        <div className="text-center">
          <h1 className="text-3xl font-semibold mb-2">WardForge Brain</h1>
          <p className="text-stone-400 text-sm">
            Internal Q&A and synthesis surface. Ask anything about the company.
          </p>
        </div>
        <a
          href={api.loginUrl()}
          className="px-5 py-2.5 bg-stone-100 text-stone-950 rounded-md font-medium hover:bg-white transition"
        >
          Sign in with Google
        </a>
        <p className="text-xs text-stone-500">
          Restricted to @ward-forge.com accounts.
        </p>
      </div>
    );
  }

  const TopNav = () => (
    <div className="border-b border-stone-800 px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-1">
        <button
          onClick={() => setView("dashboard")}
          className={`px-3 py-1.5 text-sm rounded ${
            view === "dashboard"
              ? "bg-stone-800 text-stone-100"
              : "text-stone-400 hover:bg-stone-900"
          }`}
        >
          Dashboard
        </button>
        <button
          onClick={() => setView("chat")}
          className={`px-3 py-1.5 text-sm rounded ${
            view === "chat"
              ? "bg-stone-800 text-stone-100"
              : "text-stone-400 hover:bg-stone-900"
          }`}
        >
          Chat
        </button>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-stone-500">{user.email}</span>
        <button
          onClick={() => api.logout().then(() => setUser(null))}
          className="text-xs text-stone-500 hover:text-stone-300"
        >
          Sign out
        </button>
      </div>
    </div>
  );

  if (view === "dashboard") {
    return (
      <div>
        <TopNav />
        <Dashboard onOpenChat={() => setView("chat")} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <TopNav />
      <div className="flex-1 flex overflow-hidden">
        <aside className="w-72 border-r border-stone-800 flex flex-col">
          <div className="p-3 border-b border-stone-800">
            <button
              onClick={startNewThread}
              className="w-full px-3 py-2 bg-stone-900 hover:bg-stone-800 border border-stone-700 rounded text-sm text-stone-200 transition"
            >
              + New thread
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <div className="text-xs uppercase tracking-wide text-stone-500 mb-2 px-1">
              Recent threads
            </div>
            {threads.length === 0 && (
              <div className="text-xs text-stone-600 px-1">No threads yet.</div>
            )}
            {threads.map((t) => (
              <button
                key={t.id}
                onClick={() => loadThread(t.id)}
                className={`block w-full text-left text-xs p-2 rounded mb-1 transition ${
                  currentThreadId === t.id
                    ? "bg-stone-800 text-stone-100"
                    : "text-stone-300 hover:bg-stone-900"
                }`}
              >
                <div className="line-clamp-2 leading-snug">{t.title}</div>
                <div className="text-stone-600 text-[10px] mt-1">
                  {t.created_by.name.split(" ")[0]} · {fmtTime(t.updated_at)}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex-1 flex flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6">
            {messages.length === 0 && !loadingThread && (
              <div className="max-w-2xl mx-auto pt-12 text-stone-500 text-sm">
                <p className="mb-3">
                  Ask anything about WardForge. The brain reads:
                </p>
                <ul className="list-disc list-inside space-y-1 text-stone-600">
                  <li>architecture, build plan, features</li>
                  <li>recent ADRs and weekly states</li>
                  <li>commits from the past 14 days</li>
                  <li>code in src/, worker/, frontend/, lib/, tests/</li>
                  <li>commitments + recent threads from across the team</li>
                </ul>
                <p className="mt-4 text-stone-600">
                  Conversations are threaded — follow-ups stay in context. Use{" "}
                  <em>+ New thread</em> to start fresh. The brain can also stage
                  commitments for confirmation when you mention them in the
                  conversation.
                </p>
              </div>
            )}
            {loadingThread && (
              <div className="max-w-3xl mx-auto text-stone-500 text-sm italic">
                Loading thread…
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className="max-w-3xl mx-auto">
                <div className="text-xs text-stone-500 mb-1">
                  {m.role === "user"
                    ? user.name
                    : m.role === "assistant"
                      ? "Brain"
                      : "System"}{" "}
                  · {fmtTime(m.ts)}
                </div>
                <div
                  className={
                    m.role === "user"
                      ? "bg-stone-900 rounded-lg p-4 prose-brain"
                      : m.role === "assistant"
                        ? "bg-stone-950 border border-stone-800 rounded-lg p-4 prose-brain"
                        : "text-stone-500 italic text-sm"
                  }
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {m.content}
                  </ReactMarkdown>
                </div>
                {m.role === "assistant" && (
                  <div className="mt-2 flex gap-2 text-xs">
                    <button
                      onClick={() =>
                        proposeInbox(
                          `From brain on ${new Date(m.ts).toLocaleDateString()}: ${
                            messages[i - 1]?.content?.slice(0, 80) ||
                            "follow up"
                          }`
                        )
                      }
                      className="text-stone-500 hover:text-stone-300"
                    >
                      + add to inbox
                    </button>
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="max-w-3xl mx-auto text-stone-500 text-sm italic">
                Thinking…
              </div>
            )}
          </div>

          {/* Banner stack — inbox proposals get an editable line, commitment proposals are confirm-only */}
          {banners.length > 0 && (
            <div className="border-t border-amber-700 bg-amber-950/30">
              {banners.map((b) => (
                <div
                  key={b.token}
                  className="p-4 border-b border-amber-900/40 last:border-b-0"
                >
                  <div className="max-w-3xl mx-auto">
                    <div className="text-xs uppercase tracking-wide text-amber-400 mb-2">
                      {b.kind === "inbox"
                        ? "Proposed inbox addition — review before confirming"
                        : b.proposalKind === "commitment-create"
                          ? "Brain proposes new commitment — review and confirm"
                          : "Brain proposes commitment change — review and confirm"}
                    </div>
                    {b.kind === "inbox" ? (
                      <textarea
                        value={inboxEdit}
                        onChange={(e) => setInboxEdit(e.target.value)}
                        className="w-full bg-stone-900 border border-stone-700 rounded p-2 text-sm"
                        rows={2}
                      />
                    ) : (
                      <div className="text-sm text-stone-100 bg-stone-900/60 border border-stone-700 rounded p-3 break-words">
                        {b.description}
                      </div>
                    )}
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => confirmBanner(b)}
                        className="px-3 py-1.5 bg-amber-500 text-stone-950 rounded text-sm font-medium"
                      >
                        Confirm and commit
                      </button>
                      <button
                        onClick={() => dismissBanner(b)}
                        className="px-3 py-1.5 text-stone-400 text-sm hover:text-stone-200"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-stone-800 p-4">
            <div className="max-w-3xl mx-auto flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  currentThreadId
                    ? "Continue this thread…"
                    : "Ask the brain anything…"
                }
                className="flex-1 bg-stone-900 border border-stone-800 rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:border-stone-600"
                rows={2}
                disabled={loading}
              />
              <button
                onClick={submit}
                disabled={loading || !input.trim()}
                className="px-4 py-2 bg-stone-100 text-stone-950 rounded-md text-sm font-medium disabled:opacity-50"
              >
                {currentThreadId ? "Reply" : "Ask"}
              </button>
            </div>
            <div className="max-w-3xl mx-auto text-xs text-stone-600 mt-2">
              Enter to send · Shift+Enter for newline ·{" "}
              {currentThreadId ? "thread context preserved" : "new thread"}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
