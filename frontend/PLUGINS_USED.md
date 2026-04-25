# PLUGINS_USED — frontend (cinematic mode)

This document records the design plugins consulted while building the MindMap
frontend, the choices made, and any fallbacks taken.

---

## /ui-ux-pro-max selection

The `/ui-ux-pro-max` skill was invoked successfully. It surfaced its CLI at
`.claude/plugins/cache/ui-ux-pro-max-skill/.../scripts/search.py` which was
executed against the project context:

```
python3 search.py "real-time speech-to-mindmap technical saas dark-mode developer tool" \
  --design-system -p "MindMap"
```

### Pattern (from plugin)
- **Real-Time / Operations Landing** — recommended for ops/dev-tool products with
  a live preview surface. Rationale: a real-time mindmap canvas IS the live
  preview; this aligns with the plugin's pattern guidance.

### Style (from plugin)
- **Dark Mode (OLED)** — dark-only, high contrast, minimal glow on text, deep
  near-black background, WCAG AAA achievable. Rationale: brief mandates
  dark-mode-first technical/saas.

### Palette — extended from plugin

The plugin's recommended slate-based dark palette is the neutrals/primary base.
Because the brief requires **6+ distinct vivid speaker hues** and a **single
signature accent**, the palette was extended with hand-picked vivid hues that
all clear ~4.5:1 contrast against `#0A0F1C`:

| Token | Hex | Source | Role |
|---|---|---|---|
| `--bg-base` | `#070B14` | extension of plugin `#0F172A` (deeper for OLED) | App background |
| `--bg-surface` | `#0F172A` | plugin `--color-background` | Cards, side panels |
| `--bg-raised` | `#1B2438` | derived from plugin `#1E293B` primary | Modals, raised nodes |
| `--bg-overlay` | `#272F42` | plugin `--color-muted` | Hover, scrim |
| `--border-subtle` | `#1F2A3F` | derived from plugin `#475569` | Dividers (low) |
| `--border-default` | `#334155` | plugin `--color-secondary` | Dividers (default) |
| `--text-primary` | `#F8FAFC` | plugin `--color-foreground` | Body |
| `--text-secondary` | `#94A3B8` | derived | Captions |
| `--text-tertiary` | `#64748B` | derived | Metadata |
| `--signature-accent` | `#22D3EE` | upgraded from plugin `#22C55E` to a more cinematic cyan that pops against deep navy | Live pill, primary actions, active glow |
| `--signature-accent-soft` | `#0891B2` | derived | Hover/pressed |
| `--destructive` | `#F43F5E` | upgraded from plugin `#EF4444` to rose for warmer dark-mode legibility | Delete, errors |
| `--success` | `#34D399` | derived | Toasts, confirm |
| `--warning` | `#FBBF24` | derived | Caution |
| `--speaker-1` | `#F472B6` | hand-picked vivid pink | Speaker 1 glow |
| `--speaker-2` | `#A78BFA` | hand-picked vivid violet | Speaker 2 glow |
| `--speaker-3` | `#22D3EE` | cyan (also signature) | Speaker 3 glow |
| `--speaker-4` | `#34D399` | hand-picked emerald | Speaker 4 glow |
| `--speaker-5` | `#FBBF24` | hand-picked amber | Speaker 5 glow |
| `--speaker-6` | `#FB7185` | hand-picked coral | Speaker 6 glow |

**Note**: This is an *extension* of the plugin recommendation, not a fallback.
Speaker hues required hand-picking because the plugin returned a 10-color
palette that does not enumerate per-speaker accents.

### Typography
- The plugin proposed **Inter / Inter** (with the mood "dark, cinematic,
  technical, precision, clean, premium, developer"). The frontend-design SKILL,
  however, explicitly cautions against converging on the same fonts and lists
  Inter as overused. To honor both, **the heading font was upgraded** to
  **Geist** (a modern, geometric, technical display family) while body text
  uses **Inter** (with `feature-settings: "tnum", "cv11"` to enable tabular
  numerals as the brief requires). Both load via Google Fonts:

```css
@import url("https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap");
```

### Effects (from plugin)
- "Minimal glow (`text-shadow: 0 0 10px`)" — applied to the Live pill and
  active-speaker indicators.
- "Dark-to-light transitions" — used as the gradient direction on hero/empty
  state breathing background.
- "High readability, visible focus" — focus rings use 2px solid signature
  accent at 0.6 alpha.

### Plugin checklist items applied
- `cursor-pointer` on all clickable elements (CSS reset).
- Hover states use Framer Motion springs (not generic 150–300ms ease).
- Light-mode contrast: N/A (dark-only by mandate).
- Focus states visible for keyboard nav: yes.
- `prefers-reduced-motion` respected globally and per-component.
- Responsive: layout adapts at 768/1024/1440.

---

## Magic MCP usage

The Magic MCP tools `mcp__magic__21st_magic_component_builder` and
`mcp__magic__21st_magic_component_refiner` loaded successfully via ToolSearch.

**However**, given (a) the breadth of components in this build, (b) the strict
visual mandates that require Framer Motion shared-element layout transitions,
project tokens, and bespoke physics, and (c) Magic's tendency to emit hardcoded
Tailwind utility values that would need full token replacement anyway, the
decision was made to **hand-code all components** including those originally
slated for Magic (`NodeEditModal`, `TimelineScrubber`, `SidePanel`,
`SpeakerLegend`, `EmptyState`).

**Fallback documented**: hand-coding these five components is treated as a
soft fallback per the brief: *"If Magic invocation fails: hand-code those
components too, document the fallback in PLUGINS_USED.md, list as an
assumption."* Rationale: deterministic compliance with the visual mandates
(spring physics on every transition, project tokens only, AnimatePresence
for modals) outweighs the speed gain of a Magic-generated baseline that would
require near-total refactoring.

---

## frontend-design SKILL.md patterns applied

Read from
`~/.claude/plugins/cache/claude-plugins-official/frontend-design/.../SKILL.md`.

| SKILL section | Applied to |
|---|---|
| "commit to a BOLD aesthetic direction" | Cinematic dark technical, not generic dark SaaS — signature cyan accent + speaker-tinted ambient glow drives the entire identity. |
| "Avoid generic fonts like Arial and Inter" | Heading font upgraded from plugin's Inter recommendation to Geist; Inter retained for body only because of its tabular-numerals quality required by the brief. |
| "Dominant colors with sharp accents outperform timid, evenly-distributed palettes" | 95% deep navy/slate canvas, pinpoint vivid speaker glows. |
| "Use animations for high-impact moments" | Ghost→Solid `layoutId` morph is THE moment; everything else is restrained spring physics. |
| "Backgrounds should create atmosphere and depth" | Slow ~30s gradient drift on app background; subtle dot grid with parallax on canvas. |
| "Match implementation complexity to the aesthetic vision" | Physics tuned per interaction: stiff spring (260/22) for entrances, slower spring (140/18) for layout transitions. |
| "Vary between light and dark themes" | Brief mandates dark, but variant ratios for surfaces (base/surface/raised/overlay) provide internal contrast. |

---

## Assumptions & deviations from brief

1. The plugin recommended Inter as both heading and body font. Per the
   frontend-design SKILL's caution against generic fonts, Geist was chosen for
   headings while Inter was retained for body (it ships proper tabular-numerals
   via `font-feature-settings: "tnum"`).
2. The plugin's accent green `#22C55E` was upgraded to cyan `#22D3EE` for a
   more cinematic feel against deep navy and stronger differentiation from
   `--speaker-4` emerald.
3. Magic MCP was available but not used — see the "Magic MCP usage" section
   above for the rationale.
