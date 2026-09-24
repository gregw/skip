import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetHorizonComponent } from './widget-horizon.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective } from '../../core/directives/widget-streams.directive';
import { IPathUpdate } from '../../core/services/data.service';
import type { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';

const DEG = Math.PI / 180;

// The "Show Frame" checkbox binds directly to gauge.noFrameVisible (no inversion),
// so noFrameVisible === true means "draw the frame". Two consumers must stay in
// agreement: buildOptions().frameVisible (the steelseries gauge option) and
// frameVisibleView() (drives the wrapper padding). A regression that negates one
// but not the other inverts the padding relative to the frame.
interface HorizonInternals {
  frameVisibleView: () => boolean;
  buildOptions: (cfg: IWidgetSvcConfig, size: number) => void;
  gaugeOptions: { frameVisible?: boolean };
}

function mount(noFrameVisible: boolean) {
  const options = signal<IWidgetSvcConfig | undefined>({ gauge: { type: 'horizon', noFrameVisible } });
  TestBed.configureTestingModule({
    imports: [WidgetHorizonComponent],
    providers: [
      { provide: WidgetRuntimeDirective, useValue: { options } },
      { provide: WidgetStreamsDirective, useValue: { observe: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(WidgetHorizonComponent);
  fixture.componentRef.setInput('id', 'test-horizon');
  fixture.componentRef.setInput('type', 'widget-horizon');
  fixture.componentRef.setInput('theme', null);
  fixture.detectChanges();
  return fixture.componentInstance as unknown as HorizonInternals;
}

describe('WidgetHorizonComponent frame visibility', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('draws the frame and pads the wrapper when Show Frame is on (noFrameVisible=true)', () => {
    const c = mount(true);
    c.buildOptions({ gauge: { type: 'horizon', noFrameVisible: true } } as IWidgetSvcConfig, 200);
    expect(c.gaugeOptions.frameVisible).toBe(true);
    expect(c.frameVisibleView()).toBe(true);
  });

  it('hides the frame and drops the wrapper padding when Show Frame is off (noFrameVisible=false)', () => {
    const c = mount(false);
    c.buildOptions({ gauge: { type: 'horizon', noFrameVisible: false } } as IWidgetSvcConfig, 200);
    expect(c.gaugeOptions.frameVisible).toBe(false);
    expect(c.frameVisibleView()).toBe(false);
  });
});

describe('WidgetHorizonComponent sub-field extraction', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('observes the whole navigation.attitude leaf and extracts pitch and roll', () => {
    const calls: { pathName: string; subField?: string }[] = [];
    const options = signal<IWidgetSvcConfig | undefined>({
      gauge: { type: 'horizon' },
      paths: {
        gaugePitchPath: { path: 'self.navigation.attitude', sampleTime: 1000 },
        gaugeRollPath: { path: 'self.navigation.attitude', sampleTime: 1000 },
      },
    } as unknown as IWidgetSvcConfig);
    TestBed.configureTestingModule({
      imports: [WidgetHorizonComponent],
      providers: [
        { provide: WidgetRuntimeDirective, useValue: { options } },
        {
          provide: WidgetStreamsDirective,
          useValue: {
            observe: (pathName: string, _next: unknown, subField?: string) => calls.push({ pathName, subField }),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(WidgetHorizonComponent);
    fixture.componentRef.setInput('id', 'test-horizon');
    fixture.componentRef.setInput('type', 'widget-horizon');
    fixture.componentRef.setInput('theme', null);
    fixture.detectChanges();

    expect(calls).toContainEqual({ pathName: 'gaugePitchPath', subField: 'pitch' });
    expect(calls).toContainEqual({ pathName: 'gaugeRollPath', subField: 'roll' });
  });
});

/**
 * The pitch and roll the widget hands the steelseries Horizon, which takes degrees, for a set of SI
 * inputs. Pins the output so a change of the unit the widget computes in cannot move the gauge.
 */
describe('WidgetHorizonComponent output from SI inputs', () => {
  let callbacks: Map<string, (u: IPathUpdate) => void>;
  let options: WritableSignal<IWidgetSvcConfig | undefined>;
  let drawn: { pitch?: number; roll?: number };
  let originalHorizon: unknown;

  const steel = (globalThis as unknown as { steelseries: { Horizon?: unknown } }).steelseries;

  /** An SI sample as the streams directive delivers it to this widget, with its presentation measure. */
  const feed = (pathKey: string, rad: number | null): void => {
    const callback = callbacks.get(pathKey);
    if (!callback) throw new Error(`${pathKey} is not observed`);
    callback({ data: { value: rad, timestamp: null, measure: 'deg' }, state: 'normal' } as IPathUpdate);
  };
  const feedDegrees = (pathKey: string, deg: number): void => feed(pathKey, deg * DEG);

  const shown = () => ({
    pitch: drawn.pitch == null ? drawn.pitch : Number(drawn.pitch.toFixed(6)),
    roll: drawn.roll == null ? drawn.roll : Number(drawn.roll.toFixed(6))
  });

  const makeConfig = (invertPitch = false, invertRoll = false): IWidgetSvcConfig => ({
    ...WidgetHorizonComponent.DEFAULT_CONFIG,
    gauge: { ...WidgetHorizonComponent.DEFAULT_CONFIG.gauge, type: 'horizon', invertPitch, invertRoll }
  });

  const render = (): void => {
    TestBed.configureTestingModule({
      imports: [WidgetHorizonComponent],
      providers: [
        { provide: WidgetRuntimeDirective, useValue: { options } },
        {
          provide: WidgetStreamsDirective,
          useValue: { observe: (p: string, n: (u: IPathUpdate) => void) => { callbacks.set(p, n); } }
        }
      ]
    });
    const fixture = TestBed.createComponent(WidgetHorizonComponent);
    fixture.componentRef.setInput('id', 'horizon-si');
    fixture.componentRef.setInput('type', 'widget-horizon');
    fixture.componentRef.setInput('theme', null);
    fixture.detectChanges();
    // The gauge is built on the first measured size, which jsdom never reports.
    (fixture.componentInstance as unknown as { rebuildGauge: () => void }).rebuildGauge();
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    callbacks = new Map();
    options = signal<IWidgetSvcConfig | undefined>(makeConfig());
    drawn = {};
    originalHorizon = steel.Horizon;
    steel.Horizon = class {
      setPitchAnimated(value: number) { drawn.pitch = value; }
      setRollAnimated(value: number) { drawn.roll = value; }
    };
  });

  afterEach(() => { steel.Horizon = originalHorizon; });

  it('draws pitch and roll in degrees', () => {
    render();
    feedDegrees('gaugePitchPath', 4.5);
    feedDegrees('gaugeRollPath', -12);
    expect(shown()).toEqual({ pitch: 4.5, roll: -12 });
  });

  it('draws the inverted angles, re-applying the last reading when the flags change', () => {
    render();
    feedDegrees('gaugePitchPath', 4.5);
    feedDegrees('gaugeRollPath', -12);

    options.set(makeConfig(true, true));
    TestBed.tick();
    expect(shown()).toEqual({ pitch: -4.5, roll: 12 });

    feedDegrees('gaugeRollPath', 3);
    expect(shown()).toEqual({ pitch: -4.5, roll: -3 });
  });

  it('levels an axis whose reading goes null', () => {
    render();
    feedDegrees('gaugePitchPath', 4.5);
    feed('gaugePitchPath', null);
    expect(shown().pitch).toBe(0);
  });
});
