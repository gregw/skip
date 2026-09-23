import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { WidgetConfigPanelComponent, makeConfigResultHandler } from './widget-config-panel.component';
import { WidgetService } from '../../services/widget.service';
import { DialogService } from '../../services/dialog.service';
import type { IWidgetSvcConfig } from '../../interfaces/widgets-interface';
import { signal } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ActivePolarService, ActivePolarStatus } from '../../services/active-polar.service';
import { DataService, IPathUpdate } from '../../services/data.service';
import { IConversionPathList, UnitsService } from '../../services/units.service';
import { AppService } from '../../services/app-service';
import { WidgetWindComponent } from '../../../widgets/widget-windsteer/widget-windsteer.component';
import { ensureTestIconsReady } from '../../../../test-helpers/icon-test-utils';

// Controllable bus connect: reject = "no host" (fast, no 10s handshake wait); resolve = a fake client.
const h = vi.hoisted(() => ({ connectExtension: vi.fn() }));
vi.mock('signalk-plotterext-bus/extension', () => ({ connectExtension: h.connectExtension }));

function routeWith(type: string) {
  return { snapshot: { paramMap: convertToParamMap({ type }) } } as unknown as ActivatedRoute;
}

function configPassedTo(openWidgetOptions: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return (openWidgetOptions.mock.calls[0][0] as { config: Record<string, unknown> }).config;
}

describe('makeConfigResultHandler', () => {
  it('saves the config and closes the panel on Save (a result config)', () => {
    const save = vi.fn();
    const closePanel = vi.fn();
    const cfg = { updateInterval: 2000 } as IWidgetSvcConfig;
    makeConfigResultHandler(save, closePanel)(cfg);
    expect(save).toHaveBeenCalledWith(cfg);
    expect(closePanel).toHaveBeenCalledTimes(1);
  });

  it('only closes the panel on Cancel (no result)', () => {
    const save = vi.fn();
    const closePanel = vi.fn();
    makeConfigResultHandler(save, closePanel)();
    expect(save).not.toHaveBeenCalled();
    expect(closePanel).toHaveBeenCalledTimes(1);
  });
});

describe('WidgetConfigPanelComponent', () => {
  // Default: a connected host with no saved config (state.get returns {}), so saved resolves to null
  // and the form seeds from defaults. Individual tests override for the saved-config case.
  beforeEach(() => {
    h.connectExtension.mockReset();
    h.connectExtension.mockResolvedValue({
      close: vi.fn(),
      call: vi.fn().mockResolvedValue({}),
      state: { get: async () => ({}), set: vi.fn() }
    });
  });

  function setup(widgetService: Partial<WidgetService>) {
    const openWidgetOptions = vi.fn(() => ({ afterClosed: () => of(undefined) }));
    TestBed.configureTestingModule({
      providers: [
        { provide: ActivatedRoute, useValue: routeWith('widget-wind-steer') },
        { provide: WidgetService, useValue: widgetService },
        { provide: DialogService, useValue: { openWidgetOptions } }
      ]
    });
    return { openWidgetOptions, component: TestBed.createComponent(WidgetConfigPanelComponent).componentInstance };
  }

  it('loads the widget component before reading its default config, so the options form has fields', async () => {
    // The shipped bug: getDefaultConfig returns undefined until the component is loaded, yielding an
    // empty form. Here it returns fields ONLY after getComponentType has resolved.
    let loaded = false;
    const getComponentType = vi.fn(async () => { loaded = true; return {}; });
    const getDefaultConfig = vi.fn(() => (loaded ? ({ laylineAngle: 40 } as IWidgetSvcConfig) : undefined));
    const { openWidgetOptions, component } = setup({
      getWidgetName: () => 'Wind Steer', getComponentType, getDefaultConfig
    } as unknown as Partial<WidgetService>);

    await component.ngOnInit();

    expect(getComponentType).toHaveBeenCalledWith('widget-wind-steer');
    const config = configPassedTo(openWidgetOptions);
    expect(config['laylineAngle']).toBe(40);
    expect(config['widgetName']).toBe('Wind Steer');
  });

  it('merges the saved config onto the current default so upgrade-added fields stay editable', async () => {
    const savedFromOldVersion = { laylineAngle: 30 }; // has the old field, lacks the new default field
    h.connectExtension.mockResolvedValue({
      close: vi.fn(),
      call: vi.fn().mockResolvedValue({}),
      state: { get: async () => ({ config: savedFromOldVersion }), set: vi.fn() }
    });
    let loaded = false;
    const { openWidgetOptions, component } = setup({
      getWidgetName: () => 'Wind Steer',
      getComponentType: vi.fn(async () => { loaded = true; return {}; }),
      getDefaultConfig: vi.fn(() => (loaded ? ({ laylineAngle: 40, waypointEnable: true } as IWidgetSvcConfig) : undefined))
    } as unknown as Partial<WidgetService>);

    await component.ngOnInit();

    const config = configPassedTo(openWidgetOptions);
    expect(config['laylineAngle']).toBe(30);   // saved overrides default
    expect(config['waypointEnable']).toBe(true); // new default field survives the merge (not saved-alone)
  });

  it('does not open the settings dialog for an unrecognized widget type', async () => {
    const { openWidgetOptions, component } = setup({
      getWidgetName: () => undefined, getComponentType: vi.fn(), getDefaultConfig: vi.fn()
    } as unknown as Partial<WidgetService>);

    await component.ngOnInit();

    expect(openWidgetOptions).not.toHaveBeenCalled();
  });
});

/**
 * The Freeboard settings panel has no widget instance; it opens the real options dialog with the
 * widget's default config, so the polar overlay status and missing-input hint must show there too.
 */
describe('WidgetConfigPanelComponent polar overlay status', () => {
  const update = (value: number | null): IPathUpdate =>
    ({ data: { value, timestamp: value === null ? null : new Date() }, state: 'normal' } as IPathUpdate);

  it('starts the polar service and names an overlay input the server has never sent', async () => {
    h.connectExtension.mockReset();
    h.connectExtension.mockResolvedValue({
      close: vi.fn(),
      call: vi.fn().mockResolvedValue({}),
      state: { get: async () => ({}), set: vi.fn() }
    });
    const polar = {
      status: signal<ActivePolarStatus>({ kind: 'ready' }),
      message: signal<string | null>(null),
      refreshIfFailed: vi.fn()
    };
    const received = new Set(['self.environment.wind.speedTrue', 'self.navigation.speedThroughWater']);
    TestBed.configureTestingModule({
      providers: [
        { provide: ActivatedRoute, useValue: routeWith('widget-wind-steer') },
        {
          provide: WidgetService,
          useValue: {
            getWidgetName: () => 'Wind Steer',
            getComponentType: vi.fn(async () => WidgetWindComponent),
            getDefaultConfig: () => structuredClone(WidgetWindComponent.DEFAULT_CONFIG)
          }
        },
        { provide: ActivePolarService, useValue: polar },
        { provide: UnitsService, useValue: { getConversionsForPath: (): IConversionPathList => ({ base: 'unitless', conversions: [] }), skBaseUnits: [] } },
        { provide: AppService, useValue: { configurableThemeColors: [] } }
      ]
    });
    ensureTestIconsReady();
    vi.spyOn(TestBed.inject(DataService), 'acquirePath').mockImplementation((path: string): { data$: Observable<IPathUpdate>; release: () => void } =>
      ({ data$: new BehaviorSubject(update(received.has(path) ? 1 : null)), release: () => undefined }));

    const fixture = TestBed.createComponent(WidgetConfigPanelComponent);
    await fixture.componentInstance.ngOnInit();
    TestBed.tick();

    expect(polar.refreshIfFailed).toHaveBeenCalled();
    const hint = document.querySelector('.polar-overlay-hint');
    expect(hint?.textContent?.trim()).toBe('The Signal K server has not sent environment.wind.angleTrueWater, so the overlay stays hidden.');
    fixture.destroy();
  });
});
