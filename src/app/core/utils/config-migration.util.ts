/**
 * The app-config migration steps and the in-memory chain. Free of Angular services on purpose: the
 * bootstrap migrates a config before SettingsService may be built, and the Freeboard widget host
 * and config panel migrate tile configs without the dashboard stack. ConfigurationUpgradeService
 * runs the same steps persistently over the stored slots.
 */
import { cloneDeep, has, unset } from 'lodash-es';
import type { IAppConfig, IConfig } from '../interfaces/app-settings.interfaces';
import type { Dashboard } from '../services/dashboard.service';
import { DEFAULT_WIDGET_UPDATE_INTERVAL_MS, IWidgetSvcConfig } from '../interfaces/widgets-interface';
import { LATEST_APP_CONFIG_VERSION } from '../constants/config-versions.const';

// The app-config schema version the legacy v10/v11 transforms produce. Pinned on purpose:
// bumping LATEST_APP_CONFIG_VERSION must not change what these transforms stamp — a newer
// schema needs a chained migration step here, not a re-labeled output. Divergence fails loud:
// a stamped config below latest re-raises the upgrade flag instead of masquerading as current.
export const MIGRATION_OUTPUT_VERSION = 12;

// The v12 -> v13 transform output. Pinned the same way as MIGRATION_OUTPUT_VERSION: a fixed 13,
// never LATEST_APP_CONFIG_VERSION, so a future schema bump re-raises the upgrade flag for a v13
// config instead of relabeling it as current.
export const V13_MIGRATION_OUTPUT_VERSION = 13;

// The v13 -> v14 transform output. Pinned to a fixed 14 for the same reason as the constants above.
export const V14_MIGRATION_OUTPUT_VERSION = 14;
export const V15_MIGRATION_OUTPUT_VERSION = 15;
export const V16_MIGRATION_OUTPUT_VERSION = 16;
export const V17_MIGRATION_OUTPUT_VERSION = 17;
export const V18_MIGRATION_OUTPUT_VERSION = 18;
export const V19_MIGRATION_OUTPUT_VERSION = 19;
export const V20_MIGRATION_OUTPUT_VERSION = 20;
export const V21_MIGRATION_OUTPUT_VERSION = 21;

/**
 * The per-widget SI marker: the version of the last SI step whose shape a widget config is in.
 * An SI step converts stored numbers to SI, which must happen exactly once per widget, and the
 * app-config stamp cannot guarantee that: a tab still on an older build can lower the stamp or
 * write back widget configs it loaded before the upgrade. So each SI step converts a widget only
 * when this marker is below the step's version, runs on every load of every config copy, and
 * marks what it processed. A widget's DEFAULT_CONFIG carries the marker of its latest SI step.
 */
export const SI_VERSION_KEY = 'siVersion';

type WidgetConfigRecord = Record<string, unknown>;

interface SiStep {
  version: number;
  types: ReadonlySet<string>;
  /** Converts an unmarked widget config in place. */
  convert(config: WidgetConfigRecord): void;
  /**
   * Pre-SI keys an older build can merge back into a marked config; deleted without being read.
   * Each is a property path from the widget config root, dotted for a nested option.
   */
  staleKeys: readonly string[];
}

const isRecord = (value: unknown): value is WidgetConfigRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Frozen for this step: a released step's factors never change, so what it writes cannot drift
// with the renderer's conversion table.
const V20_RAD_PER_DEG = 0.017453292519943295;

/**
 * v20: Wind Steer's close-hauled options are renamed from the misnomer `layline…` (#616) and the
 * angle is stored in rad instead of degrees.
 */
const V20_WINDSTEER_SI_STEP: SiStep = {
  version: V20_MIGRATION_OUTPUT_VERSION,
  types: new Set(['widget-wind-steer']),
  staleKeys: ['laylineEnable', 'laylineAngle'],
  convert(config) {
    if (typeof config['laylineEnable'] === 'boolean') {
      config['closeHauledLineEnable'] = config['laylineEnable'];
    }
    const angle = config['laylineAngle'];
    if (typeof angle === 'number' && Number.isFinite(angle)) {
      config['closeHauledLineAngle'] = angle * V20_RAD_PER_DEG;
    }
  }
};

// Frozen for the v21 steps, whatever later steps or the renderer's table use.
const V21_RAD_PER_DEG = 0.017453292519943295;
const V21_METRES_PER_NM = 1852;
const V21_SECONDS_PER_MINUTE = 60;

/** v21: Sea Horizon's heel caution and alarm angles are stored in rad instead of degrees. */
const V21_SEA_HORIZON_SI_STEP: SiStep = {
  version: V21_MIGRATION_OUTPUT_VERSION,
  types: new Set(['widget-sea-horizon']),
  staleKeys: [],
  convert(config) {
    const gauge = config['gauge'];
    if (!isRecord(gauge)) return;
    for (const key of ['heelCautionAngle', 'heelAlarmAngle']) {
      const angle = gauge[key];
      if (typeof angle === 'number' && Number.isFinite(angle)) {
        gauge[key] = angle * V21_RAD_PER_DEG;
      }
    }
  }
};

/**
 * v21: the AIS radar's range rings are stored in metres instead of nautical miles, and its COG
 * vector time in seconds instead of minutes, which renames `cogVectorsMinutes` to `cogVectorsSeconds`.
 */
const V21_AIS_RADAR_SI_STEP: SiStep = {
  version: V21_MIGRATION_OUTPUT_VERSION,
  types: new Set(['widget-ais-radar']),
  staleKeys: ['ais.cogVectorsMinutes'],
  convert(config) {
    const ais = config['ais'];
    if (!isRecord(ais)) return;
    const rings = ais['rangeRings'];
    if (Array.isArray(rings)) {
      ais['rangeRings'] = rings.map(nm => (typeof nm === 'number' && Number.isFinite(nm) ? nm * V21_METRES_PER_NM : nm));
    }
    const minutes = ais['cogVectorsMinutes'];
    if (typeof minutes === 'number' && Number.isFinite(minutes)) {
      ais['cogVectorsSeconds'] = minutes * V21_SECONDS_PER_MINUTE;
    }
  }
};

const SI_STEPS: readonly SiStep[] = [V20_WINDSTEER_SI_STEP, V21_SEA_HORIZON_SI_STEP, V21_AIS_RADAR_SI_STEP];

/**
 * v17 -> v18 target shape for the wind-family widgets' swept paths, keyed by runtime widget `type`
 * then path key. Each entry pins the path's canonical value and whether it stays user-editable (a
 * choice slot: true, the select offers the alternatives) or becomes fixed (false, Data Source only).
 * `pathOptions` is base-sourced from DEFAULT_CONFIG, so the migration never writes it.
 */
const V18_WIND_PATH_DEFAULTS: Record<string, Record<string, { path: string; isPathConfigurable: boolean; description?: string }>> = {
  'widget-wind-steer': {
    headingPath: { path: 'self.navigation.headingTrue', isPathConfigurable: true, description: 'Heading' },
    appWindAngle: { path: 'self.environment.wind.angleApparent', isPathConfigurable: false },
    appWindSpeed: { path: 'self.environment.wind.speedApparent', isPathConfigurable: false },
    trueWindAngle: { path: 'self.environment.wind.angleTrueWater', isPathConfigurable: true, description: 'Wind Angle' },
    trueWindSpeed: { path: 'self.environment.wind.speedTrue', isPathConfigurable: false },
    courseOverGround: { path: 'self.navigation.courseOverGroundTrue', isPathConfigurable: true, description: 'Course Over Ground' },
    set: { path: 'self.environment.current.setTrue', isPathConfigurable: false },
    drift: { path: 'self.environment.current.drift', isPathConfigurable: false },
  },
  'widget-racesteer': {
    headingPath: { path: 'self.navigation.headingTrue', isPathConfigurable: true, description: 'Heading' },
    appWindAngle: { path: 'self.environment.wind.angleApparent', isPathConfigurable: false },
    appWindSpeed: { path: 'self.environment.wind.speedApparent', isPathConfigurable: false },
    trueWindAngle: { path: 'self.environment.wind.angleTrueWater', isPathConfigurable: true, description: 'Wind Angle' },
    trueWindSpeed: { path: 'self.environment.wind.speedTrue', isPathConfigurable: false },
    courseOverGround: { path: 'self.navigation.courseOverGroundTrue', isPathConfigurable: true, description: 'Course Over Ground' },
    nextWaypointBearing: { path: 'self.navigation.course.calcValues.bearingTrue', isPathConfigurable: false },
    set: { path: 'self.environment.current.setTrue', isPathConfigurable: false },
    drift: { path: 'self.environment.current.drift', isPathConfigurable: false },
  },
  'widget-windtrends-chart': {
    trueWindDirection: { path: 'self.environment.wind.directionTrue', isPathConfigurable: true, description: 'Wind Direction' },
    trueWindSpeed: { path: 'self.environment.wind.speedTrue', isPathConfigurable: false },
  },
};

// v18 -> v19: widget-autopilot's redundant top-level pickers. heading is governed by the
// autopilot.headingDirectionTrue toggle (not a picker) and apparent wind angle has no alternative, so
// these become fixed; windAngleTrueWater was configured but never observed (dead UI) and is removed.
// Paths are unchanged, so a pinned source stays valid and is kept.
const V19_AUTOPILOT_FIXED_SLOTS = ['headingMag', 'headingTrue', 'windAngleApparent'];
const V19_AUTOPILOT_REMOVED_SLOTS = ['windAngleTrueWater'];

// SK-02 / #21: the delta parser stopped fabricating dotted child paths for compound leaves, so a
// stored widget path pointing at a sub-field of one of these leaves must be rewritten to the whole
// canonical path (the widgets read the sub-field off the whole value). Matched by suffix so a nested
// compound (e.g. courseGreatCircle.nextPoint.position) is covered as well as the top-level leaf.
const COMPOUND_SUBFIELD_PATH_SUFFIXES = [
  '.position.latitude', '.position.longitude', '.position.altitude',
  '.attitude.roll', '.attitude.pitch', '.attitude.yaw',
];

// Only the predefined widgets that were adapted to read a compound sub-field off the whole value are
// rewritten. A generic widget (numeric, gauge, ...) a user pointed at a compound sub-field has no
// sub-field accessor, so rewriting its path to the whole leaf would render a raw object — worse than
// leaving it on the now-inert child path (which shows a clean no-data placeholder). Charting a
// compound sub-field is deferred to #345. Autopilot's Next-WPT position is an internal widget config,
// not a stored path, so it is not listed here.
const SUBFIELD_WIDGET_TYPES = new Set(['widget-position', 'widget-heel-gauge', 'widget-horizon']);

/**
 * Where a migration step reports what it changed. The persistent upgrade shows these in its
 * progress overlay; an in-memory migration logs them.
 */
export interface MigrationMessageSink {
  info(message: string): void;
  error(message: string): void;
}

/** A sink for in-memory migrations, which have no overlay to report into. */
export const CONSOLE_MIGRATION_SINK: MigrationMessageSink = {
  info: message => console.log(message),
  error: message => console.warn(message)
};

/**
 * Lowest app-config version the in-memory chain migrates from. Deliberately the fork's own floor:
 * v11 reaches fork-era KIP exports, while the pre-fork v9/v10 localStorage transforms are dead in
 * Skip's storage namespace and stay with the persistent upgrade.
 */
export const MIN_MIGRATABLE_APP_CONFIG_VERSION = 11;

/**
 * A config below {@link MIN_MIGRATABLE_APP_CONFIG_VERSION}. A distinct type so a caller that can
 * offer a way around the floor, such as the profile import, can add its advice to the message.
 */
export class ConfigTooOldError extends Error {
  constructor(public readonly version: number) {
    super(`This configuration is version ${version}, which is too old to migrate automatically (the minimum is version ${MIN_MIGRATABLE_APP_CONFIG_VERSION}).`);
    this.name = 'ConfigTooOldError';
  }
}

/**
 * Whether a session renders its profile without the persistent upgrade: the chromeless embed, which
 * must never rewrite a slot, and any session storage refuses writes from. AppComponent skips the
 * upgrade for such a session and the bootstrap migrates its profile in memory instead; one predicate,
 * so a session is never migrated twice or rendered unmigrated.
 */
export function skipsPersistentUpgrade(embedMode: { embed(): boolean }, storage: { canPersist(): boolean }): boolean {
  return embedMode.embed() || !storage.canPersist();
}

/** Outcome of an in-memory migration: the current-version config and whether any step ran. */
export interface ConfigMigrationResult {
  config: IConfig;
  migrated: boolean;
}

/**
 * Upgrade a config to the current app-config version purely in memory: no slot I/O, no reload.
 * Every config copy Skip renders without the persistent upgrade goes through here: imports, the
 * published shared config, profiles loaded by a session that cannot write them, and Freeboard tile
 * configs. Throws a distinct, actionable error for a missing, below-floor or too-new version, or a
 * step that refuses its input. The caller's object is never mutated.
 */
export function migrateConfig(config: IConfig, sink: MigrationMessageSink): ConfigMigrationResult {
  const version = config.app?.configVersion as unknown;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error('This configuration has no recognizable version number.');
  }
  if (version > LATEST_APP_CONFIG_VERSION) {
    throw new Error(`This configuration is version ${version}, which is newer than this version of Skip supports (version ${LATEST_APP_CONFIG_VERSION}). Update Skip to use it.`);
  }
  if (version < MIN_MIGRATABLE_APP_CONFIG_VERSION) {
    throw new ConfigTooOldError(version);
  }

  let working = cloneDeep(config);
  let current = version;
  while (current < LATEST_APP_CONFIG_VERSION) {
    const upgraded = migrateOneAppVersion(working, current, sink);
    const nextVersion = upgraded?.app?.configVersion;
    if (!upgraded || typeof nextVersion !== 'number' || nextVersion <= current) {
      throw new Error(`This configuration could not be migrated from version ${current}.`);
    }
    working = upgraded;
    current = nextVersion;
  }
  const siChanged = applySiSteps(working, sink);
  return { config: working, migrated: version !== LATEST_APP_CONFIG_VERSION || siChanged };
}

/**
 * Runs every SI step up to `upToVersion` over a config's widgets, in place, gated only by each
 * widget's {@link SI_VERSION_KEY} marker and never by the app-config stamp. Every load of every
 * config copy goes through here before any code merges widget defaults, which carry the latest
 * marker, into a widget config. Returns whether anything changed.
 */
export function applySiSteps(config: IConfig, sink: MigrationMessageSink, upToVersion = Number.POSITIVE_INFINITY): boolean {
  if (!Array.isArray(config.dashboards)) return false;
  let converted = 0;
  let cleaned = 0;
  for (const dash of config.dashboards) {
    if (!dash || !Array.isArray(dash.configuration)) continue;
    for (const widget of dash.configuration) {
      const wp = (widget as { input?: { widgetProperties?: { type?: unknown; config?: unknown } } })?.input?.widgetProperties;
      if (!wp || typeof wp.type !== 'string' || !wp.config || typeof wp.config !== 'object') continue;
      const cfg = wp.config as WidgetConfigRecord;
      for (const step of SI_STEPS) {
        if (step.version > upToVersion || !step.types.has(wp.type)) continue;
        const marker = cfg[SI_VERSION_KEY];
        if (typeof marker !== 'number' || marker < step.version) {
          step.convert(cfg);
          cfg[SI_VERSION_KEY] = step.version;
          converted++;
        }
        for (const key of step.staleKeys) {
          if (has(cfg, key)) {
            unset(cfg, key);
            cleaned++;
          }
        }
      }
    }
  }
  if (converted) sink.info(`[Upgrade] Converted ${converted} widget config(s) to SI units.`);
  if (cleaned) sink.info(`[Upgrade] Removed ${cleaned} pre-SI option(s) from widget configs.`);
  return converted > 0 || cleaned > 0;
}

// The dashboard entry shape the steps walk to reach a widget config.
interface WidgetEntry { input: { widgetProperties: { type: string; config: IWidgetSvcConfig } } }

/**
 * Upgrade a lone widget config, such as a Freeboard tile's, from `fromVersion` to the current
 * version. The steps address widgets by type inside dashboards, so the config is wrapped in a
 * one-widget app config and run through {@link migrateConfig}: a widget-only copy of every step
 * would drift from the ones stored profiles get. Throws as `migrateConfig` does, `fromVersion`
 * standing in for the app config's version.
 */
export function migrateWidgetConfig(type: string, config: IWidgetSvcConfig, fromVersion: unknown, sink: MigrationMessageSink): IWidgetSvcConfig {
  const entry: WidgetEntry = { input: { widgetProperties: { type, config } } };
  const wrapped = {
    app: { configVersion: fromVersion },
    theme: { themeName: '' },
    dashboards: [{ id: '', configuration: [entry] }]
  } as unknown as IConfig;
  const migrated = migrateConfig(wrapped, sink).config;
  const migratedEntry = migrated.dashboards[0].configuration?.[0] as unknown as WidgetEntry;
  return migratedEntry.input.widgetProperties.config;
}

/**
 * One step of the chain, from `fromVersion` to the next version; null when no step starts there or
 * the step refused its input. The single dispatch both the persistent upgrade and the in-memory
 * chain route through, so a new LATEST_APP_CONFIG_VERSION is reachable only by adding its step here.
 */
export function migrateOneAppVersion(config: IConfig, fromVersion: number, sink: MigrationMessageSink): IConfig | null {
  switch (fromVersion) {
    case 11: return upgradeConfigV11toV12(config, sink);
    case 12: return upgradeConfigV12toV13(config, sink);
    case 13: return upgradeConfigV13toV14(config, sink);
    case 14: return upgradeConfigV14toV15(config, sink);
    case 15: return upgradeConfigV15toV16(config, sink);
    case 16: return upgradeConfigV16toV17(config, sink);
    case 17: return upgradeConfigV17toV18(config, sink);
    case 18: return upgradeConfigV18toV19(config, sink);
    case 19: return upgradeConfigV19toV20(config, sink);
    case 20: return upgradeConfigV20toV21(config, sink);
    default: return null;
  }
}

function upgradeConfigV11toV12(config: IConfig, sink: MigrationMessageSink): IConfig | null {
  try {
    const appConfig = config.app;
    if (!appConfig || appConfig.configVersion !== 11) {
      sink.error(`[Upgrade Service] Config version ${appConfig?.configVersion} upgrade is not supported. Skipping...`);
      return null;
    }
    removeSplitShellConfigKeys(appConfig);
    migrateUseNeedleToEnableNeedle(config.dashboards, sink);
    // Iterate dashboards and force widget selector to 'widget-host2'
    let updatedWidgetCount = 0;
    let dimensionUpdatedCount = 0;
    if (Array.isArray(config.dashboards)) {
      for (const dash of config.dashboards) {
        if (dash && Array.isArray(dash.configuration)) {
          for (const widget of dash.configuration) {
            if (widget && typeof widget === 'object') {
              if (widget.selector !== 'widget-host2') {
                widget.selector = 'widget-host2';
                updatedWidgetCount++;
              }
              // Helper to safely double a numeric property if > 0 (handles undefined and numeric strings)
              const maybeDouble = (prop: string) => {
                const raw = widget[prop] as unknown;
                const numVal = typeof raw === 'string' ? Number(raw) : (raw as number);
                if (Number.isFinite(numVal) && numVal !== 0) {
                  widget[prop] = numVal * 2;
                  dimensionUpdatedCount++;
                }
              };
              maybeDouble('w');
              maybeDouble('h');
              maybeDouble('x');
              maybeDouble('y');

              // If width/height were missing, add them using minW/minH (or 2)
              if (widget['w'] === undefined || widget['w'] === null) {
                const minW = widget['minW'];
                const baseW = minW ? minW : 2;
                widget['w'] = baseW;
                dimensionUpdatedCount++;
              }
              if (widget['h'] === undefined || widget['h'] === null) {
                const minH = widget['minH'];
                const baseH = minH ? minH : 2;
                widget['h'] = baseH;
                dimensionUpdatedCount++;
              }
            }
          }
        }
      }
    }
    if (updatedWidgetCount) {
      sink.info(`[Upgrade] Updated ${updatedWidgetCount} widget selector(s) to 'widget-host2'.`);
    }
    if (dimensionUpdatedCount) {
      sink.info(`[Upgrade] Doubled widget grid metrics for ${dimensionUpdatedCount} non-zero (w/h/x/y) entries.`);
    }

    appConfig.configVersion = MIGRATION_OUTPUT_VERSION;

    return {
      app: appConfig, theme: config.theme, dashboards: config.dashboards
    };

  } catch (error) {
    sink.error(`[Upgrade Service] Error upgrading ${config.app?.configVersion}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * v12 -> v13: retire the recorder's config footprint. The client-side graph recorder was removed,
 * so the app-level dataset registry and the per-widget `datasetUUID` / `chartEngine` fields it fed
 * are dead. Strip them and stamp v13. Genuine graph inputs (path/source/window/units) are untouched.
 */
function upgradeConfigV12toV13(config: IConfig, sink: MigrationMessageSink): IConfig | null {
  try {
    const appConfig = config.app;
    if (!appConfig || appConfig.configVersion !== 12) {
      sink.error(`[Upgrade Service] Config version ${appConfig?.configVersion} is not an upgradable v12 config. Skipping...`);
      return null;
    }

    delete (appConfig as unknown as Record<string, unknown>).dataSets;

    if (Array.isArray(config.dashboards)) {
      for (const dash of config.dashboards) {
        if (!dash || !Array.isArray(dash.configuration)) continue;
        for (const widget of dash.configuration) {
          const cfg = (widget as { input?: { widgetProperties?: { config?: Record<string, unknown> } } })
            ?.input?.widgetProperties?.config;
          if (cfg && typeof cfg === 'object') {
            delete cfg.datasetUUID;
            delete cfg.chartEngine;
          }
        }
      }
    }

    appConfig.configVersion = V13_MIGRATION_OUTPUT_VERSION;
    return { app: appConfig, theme: config.theme, dashboards: config.dashboards };
  } catch (error) {
    sink.error(`[Upgrade Service] Error upgrading v12->v13: ${(error as Error).message}`);
    return null;
  }
}

/**
 * v13 -> v14 (SK-02 / #21): the delta parser no longer flattens compound Signal K leaves into
 * fabricated dotted child paths. For the predefined widgets that were adapted to read a sub-field
 * off the whole value (SUBFIELD_WIDGET_TYPES only), rewrite each stored path pointing at a
 * sub-field of a known compound leaf (`navigation.position.*`, `navigation.attitude.*`) to the
 * whole canonical path, and reconcile the fields whose new defaults a stale stored value would
 * otherwise override (`isPathConfigurable` -> false; heel/horizon auto-history -> off). A generic
 * widget is deliberately left untouched (see SUBFIELD_WIDGET_TYPES). Idempotent: a path already at
 * the compound level matches no suffix.
 */
function upgradeConfigV13toV14(config: IConfig, sink: MigrationMessageSink): IConfig | null {
  try {
    const appConfig = config.app;
    if (!appConfig || appConfig.configVersion !== 13) {
      sink.error(`[Upgrade Service] Config version ${appConfig?.configVersion} is not an upgradable v13 config. Skipping...`);
      return null;
    }

    let rewritten = 0;
    if (Array.isArray(config.dashboards)) {
      for (const dash of config.dashboards) {
        if (!dash || !Array.isArray(dash.configuration)) continue;
        for (const widget of dash.configuration) {
          const wp = (widget as { input?: { widgetProperties?: {
            type?: unknown;
            config?: { paths?: unknown; supportAutomaticHistoricalSeries?: boolean };
          } } })?.input?.widgetProperties;
          if (!wp || typeof wp.type !== 'string' || !SUBFIELD_WIDGET_TYPES.has(wp.type)) continue;
          const type = wp.type;
          const cfg = wp.config;
          const paths = cfg?.paths;
          if (paths && typeof paths === 'object') {
            // paths is either a Record<string, IWidgetPath> or an IWidgetPath[]; Object.values covers both.
            for (const pathCfg of Object.values(paths as Record<string, { path?: unknown; isPathConfigurable?: boolean }>)) {
              if (!pathCfg || typeof pathCfg.path !== 'string') continue;
              if (COMPOUND_SUBFIELD_PATH_SUFFIXES.some(s => (pathCfg.path as string).endsWith(s))) {
                pathCfg.path = (pathCfg.path as string).slice(0, (pathCfg.path as string).lastIndexOf('.'));
                pathCfg.isPathConfigurable = false;
                rewritten++;
              }
            }
          }
          if (cfg && (type === 'widget-heel-gauge' || type === 'widget-horizon')) {
            cfg.supportAutomaticHistoricalSeries = false;
          }
        }
      }
    }
    if (rewritten) {
      sink.info(`[Upgrade] Rewrote ${rewritten} compound sub-field path(s) to their canonical whole path.`);
    }

    appConfig.configVersion = V14_MIGRATION_OUTPUT_VERSION;
    return { app: appConfig, theme: config.theme, dashboards: config.dashboards };
  } catch (error) {
    sink.error(`[Upgrade Service] Error upgrading v13->v14: ${(error as Error).message}`);
    return null;
  }
}

/**
 * v14 -> v15 (#414): the position widget rendered latitude and longitude from two independently
 * configurable path entries. After the compound leaves stopped being flattened (#21) a numeric
 * path can no longer point at `navigation.position.latitude`/`.longitude`, and configuring the two
 * coordinates separately never made sense. Collapse a position widget's paths to a single
 * object-typed `positionPath` pointing at the whole `navigation.position` leaf; the widget reads
 * both coordinates off it. The whole `paths` object is replaced (not field-patched) so no stale
 * `longPath`/`latPath` siblings survive the runtime default-merge. Scoped to `widget-position`
 * only — a generic widget handed the whole object would render garbage.
 */
function upgradeConfigV14toV15(config: IConfig, sink: MigrationMessageSink): IConfig | null {
  try {
    const appConfig = config.app;
    if (!appConfig || appConfig.configVersion !== 14) {
      sink.error(`[Upgrade Service] Config version ${appConfig?.configVersion} is not an upgradable v14 config. Skipping...`);
      return null;
    }

    let rewritten = 0;
    if (Array.isArray(config.dashboards)) {
      for (const dash of config.dashboards) {
        if (!dash || !Array.isArray(dash.configuration)) continue;
        for (const widget of dash.configuration) {
          const wp = (widget as { input?: { widgetProperties?: {
            type?: unknown;
            config?: { paths?: unknown };
          } } })?.input?.widgetProperties;
          if (!wp || wp.type !== 'widget-position') continue;
          const cfg = wp.config;
          if (!cfg || typeof cfg !== 'object') continue;
          // Preserve a user-pinned source / sampleTime from whichever legacy coordinate entry exists.
          const oldPaths = cfg.paths as Record<string, { source?: unknown; sampleTime?: unknown }> | undefined;
          const donor = oldPaths && typeof oldPaths === 'object'
            ? Object.values(oldPaths).find(p => p && typeof p === 'object')
            : undefined;
          cfg.paths = {
            positionPath: {
              description: 'Position',
              path: 'self.navigation.position',
              source: typeof donor?.source === 'string' ? donor.source : 'default',
              pathType: 'object',
              isPathConfigurable: true,
              showPathSkUnitsFilter: false,
              pathSkUnitsFilter: null,
              sampleTime: typeof donor?.sampleTime === 'number' ? donor.sampleTime : 500
            }
          };
          rewritten++;
        }
      }
    }
    if (rewritten) {
      sink.info(`[Upgrade] Collapsed ${rewritten} position widget(s) to a single location path.`);
    }

    appConfig.configVersion = V15_MIGRATION_OUTPUT_VERSION;
    return { app: appConfig, theme: config.theme, dashboards: config.dashboards };
  } catch (error) {
    sink.error(`[Upgrade Service] Error upgrading v14->v15: ${(error as Error).message}`);
    return null;
  }
}

/**
 * v15 -> v16 (#416): widgets whose paths are all fixed (heel-gauge, horizon, racer-timer,
 * racer-line) no longer show the widget-settings Paths tab — with it goes the data-timeout
 * control, so those widgets default to a 5 s data timeout instead. heel-gauge/horizon additionally
 * carried a stranded dead path picker (a stored entry left at `pathType: 'number'` +
 * `isPathConfigurable: true`, which a number picker can't resolve against the object leaf — the
 * bug #414 fixed for position; the v14->v15 step only rewrote position). This enables the timeout
 * on all four types and, for the two attitude widgets, resets every path entry to its canonical
 * fixed shape (`self.navigation.attitude`, `pathType: 'number'` so the pipeline's sub-field extract
 * + rad->deg conversion still runs, `isPathConfigurable: false`, `convertUnitTo: 'deg'`), discarding
 * stale stored overrides. Racer paths are already scalar/fixed, so only their timeout changes.
 */
function upgradeConfigV15toV16(config: IConfig, sink: MigrationMessageSink): IConfig | null {
  try {
    const appConfig = config.app;
    if (!appConfig || appConfig.configVersion !== 15) {
      sink.error(`[Upgrade Service] Config version ${appConfig?.configVersion} is not an upgradable v15 config. Skipping...`);
      return null;
    }

    const ATTITUDE_WIDGET_TYPES = new Set(['widget-heel-gauge', 'widget-horizon']);
    // All-fixed-path widgets whose Paths tab (and its timeout control) is now suppressed.
    const TIMEOUT_DEFAULT_WIDGET_TYPES = new Set([
      'widget-heel-gauge', 'widget-horizon', 'widget-racer-timer', 'widget-racer-line'
    ]);
    let rewritten = 0;
    if (Array.isArray(config.dashboards)) {
      for (const dash of config.dashboards) {
        if (!dash || !Array.isArray(dash.configuration)) continue;
        for (const widget of dash.configuration) {
          const wp = (widget as { input?: { widgetProperties?: {
            type?: unknown;
            config?: { paths?: unknown; enableTimeout?: boolean; dataTimeout?: number };
          } } })?.input?.widgetProperties;
          if (!wp || typeof wp.type !== 'string' || !TIMEOUT_DEFAULT_WIDGET_TYPES.has(wp.type) || !wp.config) continue;
          if (ATTITUDE_WIDGET_TYPES.has(wp.type)) {
            const paths = wp.config.paths;
            if (paths && typeof paths === 'object') {
              for (const pathCfg of Object.values(paths as Record<string, Record<string, unknown>>)) {
                if (!pathCfg || typeof pathCfg !== 'object') continue;
                // Discard stale overrides — the fixed attitude path is not user-configurable.
                pathCfg.path = 'self.navigation.attitude';
                pathCfg.pathType = 'number';
                pathCfg.isPathConfigurable = false;
                pathCfg.convertUnitTo = 'deg';
                rewritten++;
              }
            }
          }
          // The Paths tab (and its timeout control) is gone — default the timeout on.
          wp.config.enableTimeout = true;
          wp.config.dataTimeout = 5;
        }
      }
    }
    if (rewritten) {
      sink.info(`[Upgrade] Reset ${rewritten} attitude path(s) to the fixed hidden default.`);
    }

    appConfig.configVersion = V16_MIGRATION_OUTPUT_VERSION;
    return { app: appConfig, theme: config.theme, dashboards: config.dashboards };
  } catch (error) {
    sink.error(`[Upgrade Service] Error upgrading v15->v16: ${(error as Error).message}`);
    return null;
  }
}

/**
 * v16 -> v17: the per-path `sampleTime` display-cadence field is replaced by a single widget-level
 * `updateInterval` (ms). For every path-bearing widget, collapse its paths' sampleTimes to one
 * value (the minimum — the most responsive) and delete the per-path field. Widgets without paths
 * are left untouched (they have no cadence to carry).
 */
function upgradeConfigV16toV17(config: IConfig, sink: MigrationMessageSink): IConfig | null {
  try {
    const appConfig = config.app;
    if (!appConfig || appConfig.configVersion !== 16) {
      sink.error(`[Upgrade Service] Config version ${appConfig?.configVersion} is not an upgradable v16 config. Skipping...`);
      return null;
    }

    let rewritten = 0;
    if (Array.isArray(config.dashboards)) {
      for (const dash of config.dashboards) {
        if (!dash || !Array.isArray(dash.configuration)) continue;
        for (const widget of dash.configuration) {
          const wp = (widget as { input?: { widgetProperties?: {
            config?: { paths?: unknown; updateInterval?: number };
          } } })?.input?.widgetProperties;
          const cfg = wp?.config;
          if (!cfg || !cfg.paths || typeof cfg.paths !== 'object') continue;
          const sampleTimes: number[] = [];
          for (const pathCfg of Object.values(cfg.paths as Record<string, Record<string, unknown>>)) {
            if (!pathCfg || typeof pathCfg !== 'object') continue;
            const st = pathCfg['sampleTime'];
            if (typeof st === 'number' && Number.isFinite(st) && st > 0) sampleTimes.push(st);
            delete pathCfg['sampleTime'];
          }
          cfg.updateInterval = sampleTimes.length ? Math.min(...sampleTimes) : DEFAULT_WIDGET_UPDATE_INTERVAL_MS;
          rewritten++;
        }
      }
    }
    if (rewritten) {
      sink.info(`[Upgrade] Collapsed per-path sampleTime to a widget-level updateInterval on ${rewritten} widget(s).`);
    }

    appConfig.configVersion = V17_MIGRATION_OUTPUT_VERSION;
    return { app: appConfig, theme: config.theme, dashboards: config.dashboards };
  } catch (error) {
    sink.error(`[Upgrade Service] Error upgrading v16->v17: ${(error as Error).message}`);
    return null;
  }
}

/**
 * v17 -> v18: slim the wind-family widgets' path config. Reset each swept path (keyed by widget
 * type via V18_WIND_PATH_DEFAULTS) to its canonical path + fixed/choice editability + a default
 * source, discarding stored overrides (escape-hatch loss accepted). Keys are unchanged, so a
 * field-patch is safe; pathOptions is base-sourced from DEFAULT_CONFIG and is not written here.
 */
function upgradeConfigV17toV18(config: IConfig, sink: MigrationMessageSink): IConfig | null {
  try {
    const appConfig = config.app;
    if (!appConfig || appConfig.configVersion !== 17) {
      sink.error(`[Upgrade Service] Config version ${appConfig?.configVersion} is not an upgradable v17 config. Skipping...`);
      return null;
    }

    let rewritten = 0;
    if (Array.isArray(config.dashboards)) {
      for (const dash of config.dashboards) {
        if (!dash || !Array.isArray(dash.configuration)) continue;
        for (const widget of dash.configuration) {
          const wp = (widget as { input?: { widgetProperties?: {
            type?: unknown;
            config?: { paths?: unknown };
          } } })?.input?.widgetProperties;
          if (!wp || typeof wp.type !== 'string') continue;
          const targets = V18_WIND_PATH_DEFAULTS[wp.type];
          const paths = wp.config?.paths;
          if (!targets || !paths || typeof paths !== 'object') continue;
          const pathMap = paths as Record<string, Record<string, unknown>>;
          for (const [key, target] of Object.entries(targets)) {
            const pathCfg = pathMap[key];
            if (!pathCfg || typeof pathCfg !== 'object') continue;
            pathCfg['path'] = target.path;
            pathCfg['isPathConfigurable'] = target.isPathConfigurable;
            if (target.description !== undefined) pathCfg['description'] = target.description;
            // Reset the source pin too: a pin left over from the pre-reset path can point at a
            // source bucket the new canonical path never fills, silently starving the widget.
            pathCfg['source'] = 'default';
            rewritten++;
          }
        }
      }
    }
    if (rewritten) {
      sink.info(`[Upgrade] Reset ${rewritten} wind-family path(s) to the fixed/choice default.`);
    }

    appConfig.configVersion = V18_MIGRATION_OUTPUT_VERSION;
    return { app: appConfig, theme: config.theme, dashboards: config.dashboards };
  } catch (error) {
    sink.error(`[Upgrade Service] Error upgrading v17->v18: ${(error as Error).message}`);
    return null;
  }
}

/**
 * v18 -> v19: slim widget-autopilot's path config. Make its redundant top-level pickers fixed
 * (heading is governed by the autopilot.headingDirectionTrue toggle, not a path picker; apparent
 * wind angle has no alternative) and DELETE the never-observed windAngleTrueWater slot. Paths are
 * unchanged, so a pinned source stays valid and is kept. The dead slot is deleted outright because
 * the runtime base+user merge would otherwise resurrect a stored orphan key.
 */
function upgradeConfigV18toV19(config: IConfig, sink: MigrationMessageSink): IConfig | null {
  try {
    const appConfig = config.app;
    if (!appConfig || appConfig.configVersion !== 18) {
      sink.error(`[Upgrade Service] Config version ${appConfig?.configVersion} is not an upgradable v18 config. Skipping...`);
      return null;
    }

    let changed = 0;
    if (Array.isArray(config.dashboards)) {
      for (const dash of config.dashboards) {
        if (!dash || !Array.isArray(dash.configuration)) continue;
        for (const widget of dash.configuration) {
          const wp = (widget as { input?: { widgetProperties?: {
            type?: unknown;
            config?: { paths?: unknown };
          } } })?.input?.widgetProperties;
          if (!wp || wp.type !== 'widget-autopilot') continue;
          const paths = wp.config?.paths;
          if (!paths || typeof paths !== 'object') continue;
          const pathMap = paths as Record<string, Record<string, unknown>>;
          for (const slot of V19_AUTOPILOT_FIXED_SLOTS) {
            if (pathMap[slot] && typeof pathMap[slot] === 'object') {
              pathMap[slot]['isPathConfigurable'] = false;
              changed++;
            }
          }
          for (const slot of V19_AUTOPILOT_REMOVED_SLOTS) {
            if (slot in pathMap) {
              delete pathMap[slot];
              changed++;
            }
          }
        }
      }
    }
    if (changed) {
      sink.info(`[Upgrade] Slimmed ${changed} autopilot path field(s).`);
    }

    appConfig.configVersion = V19_MIGRATION_OUTPUT_VERSION;
    return { app: appConfig, theme: config.theme, dashboards: config.dashboards };
  } catch (error) {
    sink.error(`[Upgrade Service] Error upgrading v18->v19: ${(error as Error).message}`);
    return null;
  }
}

/**
 * v19 -> v20: the first SI step, for Wind Steer (see V20_WINDSTEER_SI_STEP). Also deletes racesteer's
 * `laylineEnable`/`laylineAngle`, which nothing in racesteer ever read.
 */
function upgradeConfigV19toV20(config: IConfig, sink: MigrationMessageSink): IConfig | null {
  try {
    const appConfig = config.app;
    if (!appConfig || appConfig.configVersion !== 19) {
      sink.error(`[Upgrade Service] Config version ${appConfig?.configVersion} is not an upgradable v19 config. Skipping...`);
      return null;
    }

    applySiSteps(config, sink, V20_MIGRATION_OUTPUT_VERSION);

    let removed = 0;
    if (Array.isArray(config.dashboards)) {
      for (const dash of config.dashboards) {
        if (!dash || !Array.isArray(dash.configuration)) continue;
        for (const widget of dash.configuration) {
          const wp = (widget as { input?: { widgetProperties?: { type?: unknown; config?: WidgetConfigRecord } } })?.input?.widgetProperties;
          if (!wp || wp.type !== 'widget-racesteer' || !wp.config) continue;
          for (const key of ['laylineEnable', 'laylineAngle']) {
            if (key in wp.config) {
              delete wp.config[key];
              removed++;
            }
          }
        }
      }
    }
    if (removed) {
      sink.info(`[Upgrade] Removed ${removed} unused racesteer option(s).`);
    }

    appConfig.configVersion = V20_MIGRATION_OUTPUT_VERSION;
    return { app: appConfig, theme: config.theme, dashboards: config.dashboards };
  } catch (error) {
    sink.error(`[Upgrade Service] Error upgrading v19->v20: ${(error as Error).message}`);
    return null;
  }
}

/**
 * v20 -> v21: the SI steps for Sea Horizon's heel angles and the AIS radar's range rings and COG
 * vector time (see V21_SEA_HORIZON_SI_STEP and V21_AIS_RADAR_SI_STEP).
 */
function upgradeConfigV20toV21(config: IConfig, sink: MigrationMessageSink): IConfig | null {
  try {
    const appConfig = config.app;
    if (!appConfig || appConfig.configVersion !== 20) {
      sink.error(`[Upgrade Service] Config version ${appConfig?.configVersion} is not an upgradable v20 config. Skipping...`);
      return null;
    }

    applySiSteps(config, sink, V21_MIGRATION_OUTPUT_VERSION);

    appConfig.configVersion = V21_MIGRATION_OUTPUT_VERSION;
    return { app: appConfig, theme: config.theme, dashboards: config.dashboards };
  } catch (error) {
    sink.error(`[Upgrade Service] Error upgrading v20->v21: ${(error as Error).message}`);
    return null;
  }
}

export function migrateUseNeedleToEnableNeedle(dashboards: Dashboard[], sink: MigrationMessageSink): void {
  if (!Array.isArray(dashboards)) return;
  interface WidgetHost2 { input?: { widgetProperties?: { config?: unknown } } }
  interface GaugeCfg { enableNeedle?: boolean; useNeedle?: boolean;[k: string]: unknown }
  let updatedCount = 0;
  for (const dash of dashboards) {
    if (!dash || !Array.isArray(dash.configuration)) continue;
    for (const w of dash.configuration) {
      const widget = w as WidgetHost2;
      const config = widget.input?.widgetProperties?.config as { gauge?: GaugeCfg } | undefined;
      const gauge = config?.gauge;
      if (!gauge || typeof gauge !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(gauge, 'useNeedle')) {
        if (gauge.enableNeedle === undefined) {
          gauge.enableNeedle = Boolean(gauge.useNeedle);
        } else {
          gauge.enableNeedle = Boolean(gauge.enableNeedle);
        }
        delete gauge.useNeedle;
        updatedCount++;
      }
    }
  }
  if (updatedCount) sink.info(`[Upgrade] Renamed gauge.useNeedle -> gauge.enableNeedle on ${updatedCount} widget(s).`);
}

export function removeSplitShellConfigKeys(app: IAppConfig): void {
  if (!app) return;
  // One-way cleanup: the split-shell (chartplotter) mode was removed, so strip its now-dead keys
  // from an upgraded config rather than seeding them.
  const raw = app as unknown as Record<string, unknown>;
  delete raw['splitShellEnabled'];
  delete raw['splitShellSide'];
  delete raw['splitShellWidth'];
  delete raw['splitShellSwipeDisabled'];
}
