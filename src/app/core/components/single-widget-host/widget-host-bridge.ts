import { Injectable, Signal, signal } from '@angular/core';
import type { ExtensionClient } from 'signalk-plotterext-bus/extension';
import type { IWidgetSvcConfig } from '../../interfaces/widgets-interface';
import { LATEST_APP_CONFIG_VERSION } from '../../constants/config-versions.const';
import { CONSOLE_MIGRATION_SINK, migrateWidgetConfig } from '../../utils/config-migration.util';

const LONG_PRESS_MS = 1500;
const MOVE_SLOP_PX = 10;

// Per-instance state key holding the user's saved widget config overlay. The config panel
// (WidgetConfigPanelComponent) reaches it only through the helpers below.
const WIDGET_CONFIG_STATE_KEY = 'config';

// Per-instance state key holding the app-config version the saved config conforms to. A sibling of
// the config rather than a field in it, so the stamp can never reach the widget's options.
const WIDGET_CONFIG_VERSION_STATE_KEY = 'configVersion';

// Tile configs saved before the stamp existed conform to this version. Pinned: it must not follow
// LATEST_APP_CONFIG_VERSION, or an unstamped config would skip the steps added after it.
const UNSTAMPED_TILE_CONFIG_VERSION = 19;

/**
 * The wire contract for a config value read from host state: an object is treated as a config
 * overlay, anything else (missing, null, or a non-object) as "no saved config". Single-sourced here
 * so the widget (which applies it) and the config panel (which seeds its form from it) agree.
 */
export function parseStoredConfig(value: unknown): IWidgetSvcConfig | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as IWidgetSvcConfig) : null;
}

/**
 * The host state keys a tile config is read from. Both readers request exactly these, so neither can
 * drop the version stamp and re-run steps on a config that already passed them.
 */
export const TILE_CONFIG_STATE_KEYS: readonly string[] = [WIDGET_CONFIG_STATE_KEY, WIDGET_CONFIG_VERSION_STATE_KEY];

/**
 * Read a tile's saved config from host state values and migrate it to the current version for the
 * widget `type` it belongs to, or null when none is saved or it cannot be migrated (a newer or
 * malformed stamp, a failing step). Both the widget host and the config panel read through here, so
 * the panel never seeds its form, and then stamps as current, a config the tile would migrate.
 */
export function readTileConfig(type: string, values: Record<string, unknown>): IWidgetSvcConfig | null {
  const config = parseStoredConfig(values[WIDGET_CONFIG_STATE_KEY]);
  if (!config) return null;
  const version = values[WIDGET_CONFIG_VERSION_STATE_KEY] ?? UNSTAMPED_TILE_CONFIG_VERSION;
  try {
    return migrateWidgetConfig(type, config, version, CONSOLE_MIGRATION_SINK);
  } catch (error) {
    console.warn(`[Widget Host] Ignoring the saved ${type} config: ${(error as Error).message}`);
    return null;
  }
}

/** The host state values that save a tile config, stamped with the version it conforms to. */
export function tileConfigState(config: IWidgetSvcConfig): Record<string, unknown> {
  return { [WIDGET_CONFIG_STATE_KEY]: config, [WIDGET_CONFIG_VERSION_STATE_KEY]: LATEST_APP_CONFIG_VERSION };
}

/**
 * Detect a press-and-hold anywhere in the widget iframe and invoke `onLongPress`. Listeners are
 * capture-phase on `window` so an inner gesture handler (Skip's own widget host) cannot swallow the
 * gesture via `stopPropagation`. Returns a teardown that removes the listeners.
 */
export function installLongPress(onLongPress: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    origin = null;
  };
  const down = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    cancel();
    origin = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => { timer = null; onLongPress(); }, LONG_PRESS_MS);
  };
  const move = (e: PointerEvent) => {
    if (!timer || !origin) return;
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    if (dx * dx + dy * dy > MOVE_SLOP_PX * MOVE_SLOP_PX) cancel();
  };

  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', cancel, true);
  window.addEventListener('pointercancel', cancel, true);
  return () => {
    cancel();
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', cancel, true);
    window.removeEventListener('pointercancel', cancel, true);
  };
}

/**
 * Bridges a single-widget host iframe to the Freeboard-SK plotter-extension host. A placed widget has
 * no host-side controls of its own, so two things ride the plotter-extension bus:
 *
 * - **Removal / settings menu.** A long-press relays `ui.openConfigPanel`, which opens the host
 *   dialog carrying the widget's settings panel and a Remove button. Pointer events inside the
 *   sandboxed iframe are invisible to the host, so the widget must detect and relay the gesture.
 * - **Per-instance config.** On connect it reads the user's saved config from host `state` and
 *   follows `state.changed` (written by the config panel), exposing it, migrated to the current
 *   version, as the `config` signal for the host component to apply to the live tile.
 *
 * This is the only use of the bus — the widget's data still comes from Skip's own same-origin Signal K
 * session. Opened outside a host (a direct URL) the handshake times out and this is inert.
 *
 * Scoped to the single-widget host component (not root): its state is the lifetime of one hosted
 * widget instance, and a fresh instance per mount avoids stale config leaking across a remount.
 */
@Injectable()
export class WidgetHostBridge {
  private client: ExtensionClient | null = null;
  private removeListeners: (() => void) | null = null;
  private unsubscribeState: (() => Promise<void>) | null = null;
  private disposed = false;
  private type = '';

  private readonly _config = signal<IWidgetSvcConfig | null>(null);
  /** The user's saved per-instance config overlay, or null when none. Updates live on save. */
  readonly config: Signal<IWidgetSvcConfig | null> = this._config.asReadonly();

  /** Start relaying and loading config for the hosted widget `type`, whose steps the config needs. */
  enable(type: string): void {
    if (this.removeListeners) return;
    this.type = type;
    this.removeListeners = installLongPress(() => {
      void this.client?.call('ui.openConfigPanel').catch(() => { /* no host / already open */ });
    });
    void this.connect();
  }

  disable(): void {
    this.disposed = true;
    this.removeListeners?.();
    this.removeListeners = null;
    void this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.client?.close();
    this.client = null;
  }

  private async connect(): Promise<void> {
    try {
      const { connectExtension } = await import('signalk-plotterext-bus/extension');
      const client = await connectExtension({ onError: () => { /* transport noise */ } });
      if (this.disposed) { client.close(); return; }
      this.client = client;
      await this.loadConfig();
      // Follow config the panel saves; state.changed fires on every host state.set for this instance.
      this.unsubscribeState = await client.subscribe(['state.changed'], () => { void this.loadConfig(); });
    } catch {
      // No host answered (direct-URL open) or the handshake timed out: nothing to relay or load.
    }
  }

  private async loadConfig(): Promise<void> {
    if (!this.client) return;
    try {
      const values = await this.client.state.get([...TILE_CONFIG_STATE_KEYS]);
      this._config.set(readTileConfig(this.type, values));
    } catch {
      // Host has no state capability, or the read failed: keep whatever config we last applied.
    }
  }
}
