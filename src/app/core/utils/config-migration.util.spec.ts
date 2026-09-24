import { describe, expect, it, vi } from 'vitest';
import {
  ConfigTooOldError,
  MIN_MIGRATABLE_APP_CONFIG_VERSION,
  MigrationMessageSink,
  migrateConfig,
  migrateOneAppVersion,
  migrateWidgetConfig,
  removeSplitShellConfigKeys
} from './config-migration.util';
import { IAppConfig, IConfig } from '../interfaces/app-settings.interfaces';
import { IWidgetSvcConfig } from '../interfaces/widgets-interface';
import { LATEST_APP_CONFIG_VERSION } from '../constants/config-versions.const';

const configAt = (version: unknown): IConfig =>
  ({
    app: version === undefined ? {} : { configVersion: version },
    theme: { themeName: '' },
    dashboards: []
  } as unknown as IConfig);

function recordingSink(): MigrationMessageSink & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return { infos, errors, info: m => infos.push(m), error: m => errors.push(m) };
}

// A v18 dashboard holding one autopilot whose windAngleTrueWater slot the v18 -> v19 step deletes.
const v18AutopilotConfig = (): IConfig =>
  ({
    app: { configVersion: 18 },
    theme: { themeName: '' },
    dashboards: [{
      id: 'd1',
      configuration: [{
        id: 'w1',
        selector: 'widget-host2',
        input: { widgetProperties: { type: 'widget-autopilot', uuid: 'w1', config: {
          paths: { headingTrue: { path: 'self.navigation.headingTrue', isPathConfigurable: true }, windAngleTrueWater: { path: 'x' } }
        } } }
      }]
    }]
  } as unknown as IConfig);

describe('migrateConfig (in-memory migration chain)', () => {
  it('returns a current-version config unchanged, running no step', () => {
    const config = configAt(LATEST_APP_CONFIG_VERSION);
    const result = migrateConfig(config, recordingSink());

    expect(result.migrated).toBe(false);
    expect(result.config).toBe(config);
  });

  it('migrates a floor (v11) config up to the current version without touching the caller object', () => {
    const original = configAt(MIN_MIGRATABLE_APP_CONFIG_VERSION);

    const result = migrateConfig(original, recordingSink());

    expect(result.migrated).toBe(true);
    expect(result.config.app?.configVersion).toBe(LATEST_APP_CONFIG_VERSION);
    expect(original.app?.configVersion).toBe(MIN_MIGRATABLE_APP_CONFIG_VERSION);
  });

  it('migrates an intermediate (v12) config up to the current version', () => {
    const result = migrateConfig(configAt(12), recordingSink());

    expect(result.migrated).toBe(true);
    expect(result.config.app?.configVersion).toBe(LATEST_APP_CONFIG_VERSION);
  });

  it('applies each step on the way, reporting through the sink', () => {
    const sink = recordingSink();

    const result = migrateConfig(v18AutopilotConfig(), sink);

    const paths = (result.config.dashboards[0].configuration?.[0] as unknown as {
      input: { widgetProperties: { config: { paths: Record<string, { isPathConfigurable?: boolean }> } } };
    }).input.widgetProperties.config.paths;
    expect(paths['windAngleTrueWater']).toBeUndefined();
    expect(paths['headingTrue'].isPathConfigurable).toBe(false);
    expect(sink.infos.some(m => /autopilot/i.test(m))).toBe(true);
    expect(sink.errors).toEqual([]);
  });

  it('rejects a below-floor config with a distinct "too old" error', () => {
    expect(() => migrateConfig(configAt(10), recordingSink())).toThrow(ConfigTooOldError);
    expect(() => migrateConfig(configAt(10), recordingSink())).toThrow(/too old/i);
  });

  // The chain serves the published config and Freeboard tiles as well as imports, so its errors
  // must read correctly on every path; the import path adds its own advice.
  it('words every rejection without assuming an import', () => {
    for (const version of [10, undefined, LATEST_APP_CONFIG_VERSION + 1]) {
      let message = '';
      try {
        migrateConfig(configAt(version), recordingSink());
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toMatch(/import/i);
    }
  });

  it('rejects a config with no recognizable version with a distinct error', () => {
    expect(() => migrateConfig(configAt(undefined), recordingSink())).toThrow(/recognizable version/i);
  });

  it('rejects a too-new config with a distinct "newer" error', () => {
    expect(() => migrateConfig(configAt(LATEST_APP_CONFIG_VERSION + 1), recordingSink())).toThrow(/newer/i);
  });

  it('has a step for every version from the floor up to latest (guards future LATEST bumps)', () => {
    for (let from = MIN_MIGRATABLE_APP_CONFIG_VERSION; from < LATEST_APP_CONFIG_VERSION; from++) {
      const upgraded = migrateOneAppVersion(configAt(from), from, recordingSink());
      // A bump of LATEST_APP_CONFIG_VERSION that forgets to register the new step lands here: the
      // dispatch returns null for the now-in-range version, and every config below it stops loading.
      expect(upgraded, `no upgrade step registered for config version ${from}`).not.toBeNull();
      expect(upgraded?.app?.configVersion).toBeGreaterThan(from);
    }
  });

  it('reports a step that refuses its input through the sink error channel', () => {
    const sink = recordingSink();

    expect(migrateOneAppVersion(configAt(13), 12, sink)).toBeNull();
    expect(sink.errors).toHaveLength(1);
  });
});

describe('migrateWidgetConfig (a single widget config through the chain)', () => {
  it('runs a lone widget config through the steps above its version', () => {
    const cfg = {
      paths: { headingTrue: { path: 'self.navigation.headingTrue', isPathConfigurable: true }, windAngleTrueWater: { path: 'x' } }
    } as unknown as IWidgetSvcConfig;

    const migrated = migrateWidgetConfig('widget-autopilot', cfg, 18, recordingSink());

    const paths = migrated.paths as unknown as Record<string, { isPathConfigurable?: boolean }>;
    expect(paths['windAngleTrueWater']).toBeUndefined();
    expect(paths['headingTrue'].isPathConfigurable).toBe(false);
    // The caller's object is left untouched.
    expect((cfg.paths as unknown as Record<string, unknown>)['windAngleTrueWater']).toBeDefined();
  });

  it('only runs steps that match the widget type', () => {
    const cfg = { paths: { windAngleTrueWater: { path: 'x' } } } as unknown as IWidgetSvcConfig;

    const migrated = migrateWidgetConfig('widget-numeric', cfg, 18, recordingSink());

    expect(migrated).toEqual(cfg);
  });

  it('returns a current-version widget config unchanged', () => {
    const cfg = { updateInterval: 1000 } as IWidgetSvcConfig;

    expect(migrateWidgetConfig('widget-wind-steer', cfg, LATEST_APP_CONFIG_VERSION, recordingSink())).toEqual(cfg);
  });

  it('throws for a version the chain cannot migrate from', () => {
    const cfg = { updateInterval: 1000 } as IWidgetSvcConfig;

    expect(() => migrateWidgetConfig('widget-wind-steer', cfg, LATEST_APP_CONFIG_VERSION + 1, recordingSink())).toThrow(/newer/i);
    expect(() => migrateWidgetConfig('widget-wind-steer', cfg, 'nineteen', recordingSink())).toThrow(/recognizable version/i);
  });

  it('keeps the chain free of widget-level side effects on the lone config', () => {
    // The v11 step rewrites grid metrics on the dashboard entry; those belong to the wrapper, never
    // to the widget config handed back.
    const cfg = { updateInterval: 1000 } as IWidgetSvcConfig;
    const info = vi.fn();

    const migrated = migrateWidgetConfig('widget-numeric', cfg, MIN_MIGRATABLE_APP_CONFIG_VERSION, { info, error: vi.fn() });

    expect(migrated['w' as keyof IWidgetSvcConfig]).toBeUndefined();
    expect(migrated.updateInterval).toBe(1000);
  });
});

describe('removeSplitShellConfigKeys', () => {
  it('strips the retired split-shell keys from an app config', () => {
    const app = { splitShellEnabled: true, splitShellSide: 'left', splitShellWidth: 0.3, splitShellSwipeDisabled: true, autoNightMode: true };

    removeSplitShellConfigKeys(app as unknown as IAppConfig);

    expect(app).toEqual({ autoNightMode: true });
  });
});
