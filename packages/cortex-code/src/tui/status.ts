import { type Component, type TUI, visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { colors } from './theme.js';

export interface StatusBarState {
  mode: string;
  /** Number of modes the agent can run as. The mode badge is hidden while <= 1. */
  modeCount: number;
  /**
   * The Cortex facade mode in force ('passthrough' | 'duplex'). Badged only
   * while duplex, because passthrough is what this CLI does unless asked
   * otherwise, and a badge for the default state is noise. The badge's job is
   * to let someone who passed `--duplex` (or set the config key months ago)
   * see that it took.
   */
  agentMode: string;
  provider: string;
  model: string;
  contextTokenCount: number;
  contextTokenLimit: number;
  gitBranch: string;
  yoloMode: boolean;
  effortLevel: string;
  /** Token count of the observational memory slot. */
  observationTokenCount: number;
  /** Whether the observer is currently running in the background. */
  observerActive: boolean;
  /** Whether the reflector is currently running in the background. */
  reflectorActive: boolean;
  /**
   * Whether the session's resolution report carries a `degraded` note: the
   * consumer asked for something and is not getting it. Marks the model
   * segment, because what these notes are about is the configuration the
   * session actually resolved to, which is what that segment already shows.
   *
   * `info` notes deliberately do not set this. `duplex-cost-cap-unset` fires
   * on every default duplex session, so surfacing info here would leave the
   * marker permanently lit and mean nothing.
   */
  resolutionDegraded: boolean;
  /**
   * Active sandbox rung ('restricted' | 'workspace' | 'trusted' | 'off').
   * Empty string hides the badge (state not yet known).
   */
  sandboxRung: string;
  /** How completely the OS enforces the rung. Ignored while rung is 'off'. */
  sandboxEnforcement: 'enforced' | 'partial' | 'none';
}

// ---------------------------------------------------------------------------
// Pulse animation constants
// ---------------------------------------------------------------------------

/** Dot character for the observer activity indicator. */
const PULSE_CHAR = '\u25CF'; // ●

// Observer pulse: dark to bright blue
const OBSERVER_DARK  = { r: 0x1a, g: 0x1a, b: 0x3e };
const OBSERVER_BRIGHT = { r: 0x4d, g: 0x9e, b: 0xff };

// Reflector pulse: dark to bright violet/purple
const REFLECTOR_DARK  = { r: 0x2a, g: 0x1a, b: 0x3e };
const REFLECTOR_BRIGHT = { r: 0xb4, g: 0x7e, b: 0xff };

/** Full pulse cycle duration in ms. */
const PULSE_CYCLE_MS = 2400;

/** Animation frame interval in ms (~15 FPS, smooth enough for a color fade). */
const PULSE_FRAME_MS = 66;

/**
 * Ease-in-out sine: smooth acceleration and deceleration.
 * Returns 0..1 where 0 = dark, 1 = bright.
 */
function pulseEase(t: number): number {
  return (1 - Math.cos(t * 2 * Math.PI)) / 2;
}

// ---------------------------------------------------------------------------
// Mode + flag glyphs
// ---------------------------------------------------------------------------
//
// Mode and YOLO render as bold colored text with a leading icon, not a
// background block. The U+FE0E variation selector requests text (monochrome)
// presentation so the glyph honors the chalk color and stays single-width
// where the terminal obeys it.

/** Per-mode icon, keyed by mode name. Unknown modes fall back to a neutral mark. */
const MODE_ICONS: Record<string, string> = {
  build: '⚒︎', // ⚒ hammer and pick
};
const DEFAULT_MODE_ICON = '◆'; // ◆

/** Icon for the YOLO (auto-approve) flag. */
const YOLO_ICON = '⚡︎'; // ⚡ high voltage

/**
 * Marker for a degraded resolution note, appended to the model segment.
 *
 * A dagger, dim, and nothing else. These are not errors: the session works,
 * it is just not the session the config asked for, so the marker's whole job
 * is to raise the question and let `/status` answer it. A footnote mark is
 * exactly that convention, and it reads as "there is a note here" rather than
 * as a warning, which an amber or red glyph would not.
 */
const RESOLUTION_MARK = '†';

/**
 * Footer status bar with progressive reduction.
 * Picks the most detailed layout that fits the terminal width.
 */
export class StatusBar implements Component {
  private state: StatusBarState = {
    mode: 'build',
    modeCount: 1,
    agentMode: 'passthrough',
    provider: '',
    model: '',
    contextTokenCount: 0,
    contextTokenLimit: 200_000,
    gitBranch: '',
    yoloMode: false,
    effortLevel: '',
    observationTokenCount: 0,
    observerActive: false,
    reflectorActive: false,
    resolutionDegraded: false,
    sandboxRung: '',
    sandboxEnforcement: 'none',
  };

  private hintText: string | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;

  // Pulse animation state
  private tui: TUI | null = null;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private pulseStartTime = 0;

  setState(state: Partial<StatusBarState>): void {
    const wasProcessing = this.state.observerActive || this.state.reflectorActive;
    Object.assign(this.state, state);
    const isProcessing = this.state.observerActive || this.state.reflectorActive;

    // Start/stop pulse animation when background processing changes
    if (isProcessing && !wasProcessing) {
      this.startPulse();
    } else if (!isProcessing && wasProcessing) {
      this.stopPulse();
    }
  }

  /** Provide TUI reference for driving pulse animation renders. */
  setTui(tui: TUI): void {
    this.tui = tui;
  }

  /** Show a temporary hint in place of the model text. Auto-clears after durationMs. */
  showHint(text: string, durationMs: number): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintText = text;
    this.hintTimer = setTimeout(() => {
      this.hintText = null;
      this.hintTimer = null;
    }, durationMs);
  }

  invalidate(): void {
    // No cache to clear
  }

  /** Clean up timers. */
  destroy(): void {
    this.stopPulse();
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
  }

  render(width: number): string[] {
    const s = this.state;

    // Build segments. Mode + YOLO render as bold colored text with a leading
    // icon (no background block). The mode badge is hidden while only one mode
    // exists, since there is nothing to choose between.
    const modeIcon = MODE_ICONS[s.mode] ?? DEFAULT_MODE_ICON;
    const modeBadge = s.modeCount > 1 ? `${modeIcon} ${s.mode}` : '';
    const duplexBadge = s.agentMode === 'duplex' ? 'duplex' : '';
    const yoloBadge = s.yoloMode ? `${YOLO_ICON} YOLO` : '';
    const effortBadge = s.effortLevel && s.effortLevel !== 'off'
      ? `E:${s.effortLevel.charAt(0).toUpperCase() + s.effortLevel.slice(1)}`
      : '';
    const sandboxBadge = this.buildSandboxBadge();
    const modelStr = this.hintText ?? (s.provider ? `${s.provider}/${s.model}` : s.model);
    // Suppressed while a hint is showing: the hint has replaced the model
    // text entirely, so a mark about the model would be pointing at nothing.
    const mark = s.resolutionDegraded && this.hintText === null
      ? colors.muted(` ${RESOLUTION_MARK}`)
      : '';
    const tokenStr = this.formatTokens(s.contextTokenCount, s.contextTokenLimit);
    const branchStr = s.gitBranch;
    const memStr = this.buildMemSegment();

    // Try layouts from most detailed to most minimal. The sandbox badge is the
    // honesty surface ("am I contained right now"), so it outlives the effort,
    // branch, and mem segments and is only dropped just before the minimal
    // layout on very narrow terminals. The duplex badge goes with the effort
    // badge: both describe how the session was configured, and neither is
    // worth the width once the terminal is squeezed.
    const layouts = [
      // Full: mode [duplex] [YOLO] [effort] [sandbox] | provider/model    tokens  mem Xk ●    branch
      () => this.layoutFull(modeBadge, duplexBadge, yoloBadge, effortBadge, sandboxBadge, modelStr, tokenStr, memStr, branchStr, width, mark),
      // No provider: mode [duplex] [YOLO] [effort] [sandbox] | model    tokens  mem Xk ●    branch
      () => this.layoutFull(modeBadge, duplexBadge, yoloBadge, effortBadge, sandboxBadge, s.model, tokenStr, memStr, branchStr, width, mark),
      // No effort or duplex badge: mode [YOLO] [sandbox] | model    tokens  mem Xk ●    branch
      () => this.layoutFull(modeBadge, '', yoloBadge, '', sandboxBadge, s.model, tokenStr, memStr, branchStr, width, mark),
      // No branch: mode [YOLO] [sandbox] | model    tokens  mem Xk ●
      () => this.layoutFull(modeBadge, '', yoloBadge, '', sandboxBadge, s.model, tokenStr, memStr, '', width, mark),
      // No mem: mode [YOLO] [sandbox] | model    tokens
      () => this.layoutFull(modeBadge, '', yoloBadge, '', sandboxBadge, s.model, tokenStr, '', '', width, mark),
      // No sandbox: mode [YOLO] | model    tokens
      () => this.layoutFull(modeBadge, '', yoloBadge, '', '', s.model, tokenStr, '', '', width, mark),
      // Minimal: mode    tokens
      () => this.layoutMinimal(modeBadge, tokenStr, width),
    ];

    for (const layout of layouts) {
      const result = layout();
      if (result !== null) return [result];
    }

    // Absolute fallback
    return [truncateToWidth(modeBadge || tokenStr, width)];
  }

  // -------------------------------------------------------------------------
  // Layout builders
  // -------------------------------------------------------------------------

  private layoutFull(
    modeBadge: string,
    duplexBadge: string,
    yoloBadge: string,
    effortBadge: string,
    sandboxBadge: string,
    modelStr: string,
    tokenStr: string,
    memStr: string,
    branchStr: string,
    width: number,
    /** Pre-colored resolution marker, or '' when there is nothing to note. */
    mark: string,
  ): string | null {
    const flags: string[] = [];
    if (modeBadge) flags.push(colors.bold(colors.primary(modeBadge)));
    // Muted, like the effort badge: a fact about the session, not a warning.
    if (duplexBadge) flags.push(colors.muted(duplexBadge));
    if (yoloBadge) flags.push(colors.bold(colors.accent(yoloBadge)));
    if (effortBadge) flags.push(colors.muted(effortBadge));
    if (sandboxBadge) flags.push(sandboxBadge); // pre-colored (state-dependent)
    const flagStr = flags.join('  ');

    const left = (flagStr ? flagStr + colors.muted(' | ') : '')
      + colors.white(modelStr)
      + mark;

    const right = this.colorizeTokens(tokenStr)
      + (memStr ? colors.muted('  ') + memStr : '')
      + (branchStr ? colors.muted('   ') + colors.muted(branchStr) : '');

    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const totalNeeded = leftWidth + 4 + rightWidth; // 4 = minimum gap

    if (totalNeeded > width) return null;

    const gap = width - leftWidth - rightWidth;
    return left + ' '.repeat(gap) + right;
  }

  private layoutMinimal(modeBadge: string, tokenStr: string, width: number): string | null {
    const left = modeBadge ? colors.bold(colors.primary(modeBadge)) : '';
    const right = this.colorizeTokens(tokenStr);
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const totalNeeded = leftWidth + 2 + rightWidth;

    if (totalNeeded > width) return null;

    const gap = width - leftWidth - rightWidth;
    return left + ' '.repeat(gap) + right;
  }

  // -------------------------------------------------------------------------
  // Sandbox badge
  // -------------------------------------------------------------------------

  /**
   * The always-visible containment indicator. Honest by construction:
   * - enforced contained rung   -> "sandbox: workspace" (calm, muted)
   * - partial OS enforcement    -> "sandbox: workspace (partial)" (warning)
   * - configured, not enforced  -> "sandbox: workspace (not enforced)" (error)
   * - off                       -> "sandbox: off" (loud, like the YOLO badge)
   * Empty rung (state not yet reported) hides the badge.
   */
  private buildSandboxBadge(): string {
    const s = this.state;
    if (!s.sandboxRung) return '';
    if (s.sandboxRung === 'off') return colors.bold(colors.accent('sandbox: off'));
    const label = `sandbox: ${s.sandboxRung}`;
    switch (s.sandboxEnforcement) {
      case 'enforced':
        return colors.muted(label);
      case 'partial':
        return colors.accent(`${label} (partial)`);
      case 'none':
        return colors.error(`${label} (not enforced)`);
    }
  }

  // -------------------------------------------------------------------------
  // Observational memory segment
  // -------------------------------------------------------------------------

  private buildMemSegment(): string {
    const s = this.state;
    const countStr = s.observationTokenCount >= 1000
      ? `${(s.observationTokenCount / 1000).toFixed(1)}k`
      : String(s.observationTokenCount);

    const label = colors.muted(`mem ${countStr}`);
    const isProcessing = s.observerActive || s.reflectorActive;

    if (isProcessing) {
      const dot = this.renderPulseDot();
      return `${label} ${dot}`;
    }

    return label;
  }

  // -------------------------------------------------------------------------
  // Pulse animation
  // -------------------------------------------------------------------------

  private renderPulseDot(): string {
    // Reflector takes priority for color (it's the rarer, more notable event)
    const dark = this.state.reflectorActive ? REFLECTOR_DARK : OBSERVER_DARK;
    const bright = this.state.reflectorActive ? REFLECTOR_BRIGHT : OBSERVER_BRIGHT;

    const elapsed = Date.now() - this.pulseStartTime;
    const t = (elapsed % PULSE_CYCLE_MS) / PULSE_CYCLE_MS;
    const k = pulseEase(t);

    const r = Math.round(dark.r + (bright.r - dark.r) * k);
    const g = Math.round(dark.g + (bright.g - dark.g) * k);
    const b = Math.round(dark.b + (bright.b - dark.b) * k);

    return chalk.rgb(r, g, b)(PULSE_CHAR);
  }

  private startPulse(): void {
    if (this.pulseTimer) return;
    this.pulseStartTime = Date.now();
    this.pulseTimer = setInterval(() => {
      this.tui?.requestRender();
    }, PULSE_FRAME_MS);
  }

  private stopPulse(): void {
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Token formatting
  // -------------------------------------------------------------------------

  private formatTokens(count: number, limit: number): string {
    const countStr = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
    const limitStr = limit >= 1000 ? `${(limit / 1000).toFixed(0)}k` : String(limit);
    return `${countStr}/${limitStr} tokens`;
  }

  private colorizeTokens(tokenStr: string): string {
    const ratio = this.state.contextTokenLimit > 0
      ? this.state.contextTokenCount / this.state.contextTokenLimit
      : 0;

    if (ratio >= 0.9) return colors.error(tokenStr);
    if (ratio >= 0.75) return colors.accent(tokenStr);
    if (ratio >= 0.5) return colors.accent(tokenStr);
    return colors.success(tokenStr);
  }
}
