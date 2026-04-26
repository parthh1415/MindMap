import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Files, GitBranch, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { useSessionStore } from "@/state/sessionStore";
import { ArtifactButton } from "@/components/ArtifactButton";
import { useArtifactStore } from "@/state/artifactStore";

/**
 * Pinned bar across the top of the canvas. 56 px tall, near-transparent
 * with a backdrop blur and a thin bottom border. Wordmark + phosphor-dot
 * logomark on the left, editable session name in the center, status
 * affordances on the right (sound toggle, branch chip, LIVE/OFF mic pill).
 *
 * The mic pill is the only thing that should pull the eye when active —
 * it picks up the volt signature accent and softly pulses.
 */
export function TopBar() {
  const reduce = useReducedMotion();
  const sessionName = useSessionStore((s) => s.currentSessionName);
  const setSessionName = useSessionStore((s) => s.setSessionName);
  const micActive = useSessionStore((s) => s.micActive);
  const setMicActive = useSessionStore((s) => s.setMicActive);
  const branches = useSessionStore((s) => s.branchedSessions);
  const sidePanelOpen = useSessionStore((s) => s.sidePanelOpen);
  const setSidePanelOpen = useSessionStore((s) => s.setSidePanelOpen);
  const soundEnabled = useSessionStore((s) => s.soundEnabled);
  const setSoundEnabled = useSessionStore((s) => s.setSoundEnabled);

  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-mark" aria-hidden>
          <span className="topbar-mark-dot" />
          <span className="topbar-mark-text">MINDMAP</span>
        </span>
        <span className="topbar-divider" aria-hidden />
        {editing ? (
          <input
            ref={inputRef}
            className="topbar-name-input"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="topbar-name"
            onClick={() => setEditing(true)}
            title="Rename session"
          >
            {sessionName || "Untitled"}
          </button>
        )}
        {branches.length > 0 ? (
          <button
            type="button"
            className="topbar-branch"
            onClick={() => setSidePanelOpen(!sidePanelOpen)}
            aria-label="Toggle branches panel"
          >
            <GitBranch size={11} />
            <span className="tabular">{branches.length}</span>
          </button>
        ) : null}
      </div>

      <div className="topbar-right">
        <button
          type="button"
          className={`topbar-icon ${soundEnabled ? "is-on" : ""}`}
          onClick={() => setSoundEnabled(!soundEnabled)}
          aria-label={soundEnabled ? "Mute sounds" : "Enable sounds"}
          title={soundEnabled ? "Mute sounds" : "Enable sound effects"}
        >
          {soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        <ArtifactHistoryButton />
        <ArtifactButton />
        <motion.button
          type="button"
          className={`topbar-mic ${micActive ? "is-live" : ""}`}
          onClick={() => setMicActive(!micActive)}
          aria-pressed={micActive}
          aria-label={micActive ? "Stop mic" : "Start mic"}
          animate={
            micActive && !reduce
              ? {
                  boxShadow: [
                    "0 0 0 0 rgba(214,255,58,0.55), 0 0 18px rgba(214,255,58,0.30)",
                    "0 0 0 6px rgba(214,255,58,0.00), 0 0 22px rgba(214,255,58,0.20)",
                  ],
                }
              : { boxShadow: "none" }
          }
          transition={{ duration: 1.4, repeat: micActive ? Infinity : 0, ease: "easeOut" }}
        >
          <span className={`topbar-mic-led ${micActive ? "is-live" : ""}`} />
          {micActive ? <Mic size={12} /> : <MicOff size={12} />}
          <span className="tabular">{micActive ? "LIVE" : "OFF"}</span>
        </motion.button>
      </div>

      <style>{`
        .topbar {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 56px;
          z-index: 50;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 var(--sp-5);
          background: rgba(6, 9, 13, 0.72);
          backdrop-filter: blur(14px) saturate(160%);
          -webkit-backdrop-filter: blur(14px) saturate(160%);
          border-bottom: 1px solid var(--border-subtle);
        }
        .topbar-left, .topbar-right {
          display: flex;
          align-items: center;
          gap: var(--sp-3);
        }
        .topbar-mark {
          display: inline-flex;
          align-items: center;
          gap: var(--sp-2);
        }
        .topbar-mark-dot {
          width: 9px; height: 9px;
          border-radius: 999px;
          background: var(--signature-accent);
          box-shadow: 0 0 14px var(--signature-accent-glow);
          display: inline-block;
        }
        .topbar-mark-text {
          font-family: var(--font-display);
          font-weight: 600;
          font-size: var(--fs-xs);
          letter-spacing: 0.22em;
          color: var(--text-secondary);
        }
        .topbar-divider {
          width: 1px; height: 18px;
          background: var(--border-subtle);
        }
        .topbar-name {
          font-family: var(--font-display);
          font-size: var(--fs-md);
          font-weight: 500;
          color: var(--text-primary);
          padding: 6px 10px;
          border-radius: var(--radius-sm);
          letter-spacing: -0.005em;
        }
        .topbar-name:hover { background: var(--bg-overlay); color: var(--text-primary); }
        .topbar-name-input {
          font-family: var(--font-display);
          font-size: var(--fs-md);
          font-weight: 500;
          color: var(--text-primary);
          background: var(--bg-overlay);
          padding: 6px 10px;
          border-radius: var(--radius-sm);
          min-width: 220px;
          border: 1px solid var(--border-default);
        }
        .topbar-branch {
          display: inline-flex;
          align-items: center;
          gap: var(--sp-1);
          padding: 4px 8px;
          font-family: var(--font-mono);
          font-size: var(--fs-xs);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: 999px;
          background: var(--bg-raised);
        }
        .topbar-branch:hover {
          color: var(--signature-accent);
          border-color: var(--signature-accent-soft);
        }
        .topbar-icon {
          width: 30px; height: 30px;
          display: grid; place-items: center;
          border-radius: var(--radius-sm);
          color: var(--text-tertiary);
        }
        .topbar-icon:hover {
          background: var(--bg-overlay);
          color: var(--text-primary);
        }
        .topbar-icon.is-on { color: var(--signature-accent); }

        .topbar-mic {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px 6px 10px;
          border-radius: 999px;
          background: var(--bg-raised);
          border: 1px solid var(--border-default);
          color: var(--text-secondary);
          font-family: var(--font-display);
          font-size: var(--fs-xs);
          font-weight: 600;
          letter-spacing: 0.12em;
        }
        .topbar-mic.is-live {
          background: var(--signature-accent);
          color: var(--signature-accent-fg);
          border-color: var(--signature-accent);
        }
        .topbar-mic-led {
          width: 6px; height: 6px;
          border-radius: 999px;
          background: var(--text-tertiary);
          display: inline-block;
        }
        .topbar-mic-led.is-live {
          background: var(--signature-accent-fg);
          box-shadow: 0 0 6px rgba(0,0,0,0.35) inset;
        }
      `}</style>
    </header>
  );
}

/**
 * Tiny icon-only button that opens the artifact history dropdown. Defined
 * inline to keep TopBar's wiring contained.
 */
function ArtifactHistoryButton() {
  const openHistory = useArtifactStore((s) => s.openHistory);
  return (
    <button
      type="button"
      className="topbar-icon"
      onClick={() => void openHistory()}
      aria-label="Open artifact history"
      title="Past artifacts"
      data-testid="artifact-history-button"
    >
      <Files size={14} />
    </button>
  );
}

export default TopBar;
