import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { GitBranch, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { useSessionStore } from "@/state/sessionStore";

/**
 * Top bar:
 *   - Editable session name (inline rename)
 *   - Branch indicator (visible when current session has branches)
 *   - Mic status with animated glow when active
 *   - Sound toggle (Web Audio click for node creation/merge — off by default)
 */
export function TopBar() {
  const reduceMotion = useReducedMotion();
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
            {sessionName}
          </button>
        )}
        {branches.length > 0 ? (
          <button
            type="button"
            className="topbar-branch"
            onClick={() => setSidePanelOpen(!sidePanelOpen)}
            aria-label="Toggle branches panel"
          >
            <GitBranch size={12} />
            <span className="tabular">{branches.length}</span>
          </button>
        ) : null}
      </div>

      <div className="topbar-right">
        <button
          type="button"
          className={`topbar-icon ${soundEnabled ? "topbar-icon--active" : ""}`}
          onClick={() => setSoundEnabled(!soundEnabled)}
          aria-label={soundEnabled ? "Mute sounds" : "Unmute sounds"}
          title={soundEnabled ? "Mute sounds" : "Enable sound effects"}
        >
          {soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        <motion.button
          type="button"
          className={`topbar-mic ${micActive ? "topbar-mic--active" : ""}`}
          onClick={() => setMicActive(!micActive)}
          aria-pressed={micActive}
          aria-label={micActive ? "Stop mic" : "Start mic"}
          animate={
            micActive && !reduceMotion
              ? {
                  boxShadow: [
                    "0 0 0 0 rgba(34, 211, 238, 0.6)",
                    "0 0 0 6px rgba(34, 211, 238, 0)",
                  ],
                }
              : {}
          }
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
        >
          {micActive ? <Mic size={14} /> : <MicOff size={14} />}
          <span className="tabular">{micActive ? "LIVE" : "OFF"}</span>
        </motion.button>
      </div>

      <style>{`
        .topbar {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          z-index: var(--z-top);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--space-3) var(--space-5);
          background: linear-gradient(180deg, rgba(7, 11, 20, 0.85), transparent);
          backdrop-filter: blur(6px);
        }
        .topbar-left, .topbar-right {
          display: flex;
          align-items: center;
          gap: var(--space-3);
        }
        .topbar-name {
          font-family: var(--font-display);
          font-size: var(--font-size-md);
          font-weight: 600;
          color: var(--text-primary);
          padding: var(--space-1) var(--space-2);
          border-radius: var(--radius-sm);
        }
        .topbar-name:hover { background: var(--bg-overlay); }
        .topbar-name-input {
          font-family: var(--font-display);
          font-size: var(--font-size-md);
          font-weight: 600;
          color: var(--text-primary);
          background: var(--bg-overlay);
          padding: var(--space-1) var(--space-2);
          border-radius: var(--radius-sm);
          min-width: 220px;
        }
        .topbar-branch {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) var(--space-2);
          font-size: var(--font-size-xs);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-pill);
        }
        .topbar-branch:hover { color: var(--signature-accent); border-color: var(--signature-accent-soft); }
        .topbar-icon {
          width: 28px;
          height: 28px;
          display: grid;
          place-items: center;
          border-radius: var(--radius-sm);
          color: var(--text-secondary);
        }
        .topbar-icon:hover { background: var(--bg-overlay); color: var(--text-primary); }
        .topbar-icon--active { color: var(--signature-accent); }
        .topbar-mic {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-1) var(--space-3);
          border-radius: var(--radius-pill);
          background: var(--bg-overlay);
          color: var(--text-secondary);
          font-family: var(--font-display);
          font-size: var(--font-size-xs);
          letter-spacing: 0.1em;
          font-weight: 600;
        }
        .topbar-mic--active {
          background: var(--signature-accent);
          color: var(--text-inverse);
        }
      `}</style>
    </header>
  );
}

export default TopBar;
