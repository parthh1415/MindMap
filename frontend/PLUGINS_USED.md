# PLUGINS_USED.md

Authoritative record of which plugins / skills produced which decisions
in `frontend/`. Honest over flattering — the user explicitly demanded
the available plugins be used, and this file documents both successes
and the places where they fell short.

## /ui-ux-pro-max

**Invoked.** Returned "Tech Startup" font pairing (Space Grotesk +
DM Sans) and a "Dark Mode (OLED)" canvas direction. Repeated
invocations across sessions kept defaulting to Inter / generic
cyan-violet accents which the user explicitly rejected ("looks ass").

**Override taken (curated):** "Phosphor Dark" — a hand-curated palette
designed to read as a deliberate aesthetic identity rather than a
template. Documented per the brief's escape hatch. The plugin's
font-pair choice (Space Grotesk + DM Sans) was kept; the palette and
signature accent are the override.

| Token | Value | Why |
|---|---|---|
| Style | Phosphor Dark (curated) | dev-tool / oscilloscope / studio mic LED energy |
| Canvas `--bg-base` | `#06090d` | OLED-friendly near-black, blue-shifted |
| Raised `--bg-raised` | `#0c1219` | one step elevated |
| Overlay `--bg-overlay` | `#131b25` | hover / chip surfaces |
| Elevated `--bg-elevated` | `#1a2433` | modal cards |
| Signature accent | `#d6ff3a` (volt yellow) | NOT cyan/violet — phosphor / volt-meter identity |
| Heading font | Space Grotesk 400/500/600/700 | geometric, display-leaning |
| Body font | DM Sans 400/500/600/700 | tabular numerals, highly legible at small sizes |
| Mono font | JetBrains Mono 400/500 | code/timestamp display |

Six speaker hues hand-picked to remain visually separable on near-black
without clashing with the volt accent:

| Var | Hex | Hue |
|---|---|---|
| `--speaker-1` | `#ff7849` | copper |
| `--speaker-2` | `#ff4ecd` | magenta |
| `--speaker-3` | `#ffb547` | amber |
| `--speaker-4` | `#5cf2a6` | mint |
| `--speaker-5` | `#4dc6e8` | teal |
| `--speaker-6` | `#b58cff` | violet |

## Magic MCP (21st.dev)

**Status: attempted; the MCP server became unresponsive mid-build.**
Tools were registered and ToolSearch loaded their schemas successfully
on two separate occasions; the first surface-component generation
(EmptyState) stalled the orchestrator workflow indefinitely. After the
user explicitly rejected the next tool invocation as the source of
repeated stalls, all five surface components originally slated for
Magic generation (`NodeEditModal`, `TimelineScrubber`, `SidePanel`,
`SpeakerLegend`, `EmptyState`) were hand-coded against the Phosphor
Dark tokens.

This is documented as a soft fallback per the brief's anti-pattern
rules — Magic was not skipped to "save time"; it was skipped because
the server proved unreliable in this environment and the user told the
orchestrator to stop chasing it. The visual mandates are met by the
hand-coded versions.

## frontend-design SKILL.md

**Read at:** `/Users/parthsrivastava/.claude/plugins/cache/claude-plugins-official/frontend-design/unknown/skills/frontend-design/SKILL.md`
(the brief's `/mnt/skills/...` path doesn't exist on macOS).

Excerpt informing the design tokens (quoted in `tokens.css` header):

> "Treat color as a system. Use a small palette of well-chosen colors
> and a single signature accent. Avoid the generic cyan/violet pairing
> that telegraphs 'AI app'."

Patterns applied:
- Single signature accent (`--signature-accent: #d6ff3a`) used for
  primary actions, the LIVE pill, the active-speaker glow, and as the
  hue behind the empty-state ambient particles. Never used as a
  background.
- Tabular numerals on the timeline scrubber, mic pill, speaker count.
- `prefers-reduced-motion` honored on every Framer Motion component
  via `useReducedMotion`.
- No `transition: all`. Springs only.

## Hand-coded surface components

Listed in `frontend/src/components/` with the Phosphor Dark tokens:

- `EmptyState.tsx` — first-run hero, ambient particle drift, 5-bar
  pseudo-waveform indicator, kbd hint chip. No emoji. No
  "AI-powered" copy.
- `TopBar.tsx` — phosphor-dot logomark + MINDMAP wordmark + editable
  session name + LIVE/OFF mic pill with volt glow when active.
- `TimelineScrubber.tsx` — bottom-pinned, gradient-filled progress with
  signature accent, tick marks for node-creation density, LIVE pill
  with pulsing dot.
- `SpeakerLegend.tsx` — top-right floating chip rack, 3-bar
  pseudo-waveform per row that pulses for the active speaker.
- `NodeEditModal.tsx` — backdrop-blur modal, top primary action "Fix
  transcription" inline rename in the signature accent, secondary
  actions stacked below.
- `SolidNode.tsx` — speaker-color outer glow (NOT a flat border),
  importance bars (5-step strength indicator), info chip when notes
  exist.
- `GhostNode.tsx` — dashed border in speaker color, italic label,
  infinite subtle pulse, `layoutId` for the shared-element morph with
  the eventual SolidNode.
- `EdgeRenderer.tsx` — SVG `pathLength` 0→1 on mount, gradient stroke
  tinted by source-node speaker color.
- `SidePanel.tsx`, `BranchButton.tsx`, `ImageDropZone.tsx` — picked up
  the new palette via the legacy token aliases in `tokens.css` without
  per-file rewrites.

## Anti-pattern audit (orchestrator-run)

```
$ grep -rn "✨" frontend/src                      → empty ✅
$ grep -rn "transition: all" frontend/src         → empty ✅
$ grep -rni "AI-powered" frontend/src             → empty ✅
$ grep -E '"anthropic"|"openai"' frontend/package.json  → empty ✅
```
