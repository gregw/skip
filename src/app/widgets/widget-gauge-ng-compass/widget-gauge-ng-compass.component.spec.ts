import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WidgetGaugeNgCompassComponent } from './widget-gauge-ng-compass.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective } from '../../core/directives/widget-streams.directive';
import { UnitsService } from '../../core/services/units.service';
import { IPathUpdate } from '../../core/services/data.service';
import { IWidgetSvcConfig, IPathArray } from '../../core/interfaces/widgets-interface';
import { States } from '../../core/interfaces/signalk-interfaces';

const DEG = Math.PI / 180;

/**
 * A compass with no heading must still show its rose, with no needle and a '--' readout — a needle
 * parked on north is indistinguishable from a real heading of 000.
 *
 * Harness follows the radial gauge spec: the host directives are faked and the
 * @godind/ng-canvas-gauges lib is aliased to a no-op shim in the test build, so the gauge element
 * renders as a bare canvas and the component's guarded update() calls are no-ops.
 */
describe('WidgetGaugeNgCompassComponent no-data state', () => {
  let fixture: ComponentFixture<WidgetGaugeNgCompassComponent>;
  let internals: CompassInternals;
  let capturedNext: ((u: IPathUpdate) => void) | undefined;
  let options: WritableSignal<IWidgetSvcConfig | undefined>;
  let observeCount: number;
  let replayOnObserve: IPathUpdate | undefined;

  interface CompassInternals {
    value: () => number | null | undefined;
    textValue: () => string;
    dataAvailable: () => boolean;
    currentState: () => string;
    optionsReady: () => boolean;
    gaugeOptions: { needle?: boolean };
  }

  const makeConfig = (path: string | null = 'self.navigation.headingTrue'): IWidgetSvcConfig => {
    const dflt = WidgetGaugeNgCompassComponent.DEFAULT_CONFIG;
    const gaugePath = (dflt.paths as IPathArray)['gaugePath'];
    return {
      ...dflt,
      paths: { gaugePath: { ...gaugePath, path } }
    };
  };

  // The tests speak degrees; the widget takes its reading in rad.
  const update = (deg: number | null): IPathUpdate =>
    ({ data: { value: deg == null ? null : deg * DEG, timestamp: null }, state: 'normal' }) as unknown as IPathUpdate;

  beforeEach(async () => {
    capturedNext = undefined;
    options = signal<IWidgetSvcConfig | undefined>(makeConfig());
    observeCount = 0;
    replayOnObserve = undefined;
    const streamsFake = {
      observe(_pathName: string, next: (u: IPathUpdate) => void) {
        capturedNext = next;
        observeCount++;
        // The real directive replays a BehaviorSubject, so a path holding a value delivers it
        // synchronously inside the same effect run as the clear.
        if (replayOnObserve) next(replayOnObserve);
      },
      useSiValues: () => undefined
    };
    const unitsFake = {
      getUnitDisplaySymbol: (measure: string | null | undefined): string => measure ?? ''
    };

    await TestBed.configureTestingModule({
      imports: [WidgetGaugeNgCompassComponent],
      providers: [
        { provide: WidgetRuntimeDirective, useValue: { options } },
        { provide: WidgetStreamsDirective, useValue: streamsFake },
        { provide: UnitsService, useValue: unitsFake }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(WidgetGaugeNgCompassComponent);
    fixture.componentRef.setInput('id', 'compass-1');
    fixture.componentRef.setInput('type', 'widget-gauge-ng-compass');
    fixture.componentRef.setInput('theme', {
      contrast: 'rgba(255,255,255,1)', contrastDim: 'rgba(200,200,200,1)',
      contrastDimmer: 'rgba(150,150,150,1)', cardColor: 'rgba(17,17,17,1)',
      background: 'rgba(0,0,0,1)', zoneAlarm: 'rgba(255,0,0,1)',
      zoneWarn: 'rgba(255,170,0,1)', zoneAlert: 'rgba(255,0,255,1)',
      zoneEmergency: 'rgba(255,0,0,1)'
    });
    fixture.detectChanges();
    internals = fixture.componentInstance as unknown as CompassInternals;
  });

  it('renders the rose before any heading arrives, with no needle', () => {
    expect(internals.optionsReady()).toBe(true);
    expect(fixture.nativeElement.querySelector('radial-gauge')).not.toBeNull();
    expect(internals.dataAvailable()).toBe(false);
    expect(internals.gaugeOptions.needle).toBe(false);
    expect(internals.textValue()).toBe('--');
  });

  it('shows the needle and the heading once one arrives', () => {
    capturedNext?.(update(142));
    expect(internals.dataAvailable()).toBe(true);
    expect(internals.value()).toBe(142);
    expect(internals.textValue()).toBe('142');
  });

  it('returns to the placeholder when the heading stops arriving', () => {
    capturedNext?.(update(142));
    capturedNext?.(update(null));
    expect(internals.dataAvailable()).toBe(false);
    expect(internals.textValue()).toBe('--');
  });

  // #534: a rebuilt subscription against a silent path replays nothing (the leading null is
  // suppressed), so the callback never runs and the previous heading stayed on the rose.
  it('clears the heading when re-pointed at a path that reports nothing', () => {
    capturedNext?.(update(142));
    expect(internals.dataAvailable()).toBe(true);

    options.set(makeConfig('self.navigation.headingMagnetic'));
    fixture.detectChanges();

    expect(internals.dataAvailable()).toBe(false);
    expect(internals.value()).toBeUndefined();
    expect(internals.textValue()).toBe('--');
  });

  // Clearing the path entirely drops the subscription, so the heading has to go with it. This is
  // what pins the clear ahead of the no-path bail-out rather than after it.
  it('clears the heading when the path is cleared entirely', () => {
    capturedNext?.(update(142));
    expect(internals.dataAvailable()).toBe(true);

    options.set(makeConfig(null));
    fixture.detectChanges();

    expect(internals.dataAvailable()).toBe(false);
    expect(internals.value()).toBeUndefined();
    expect(internals.textValue()).toBe('--');
  });

  // currentState colours the heading text independently of dataAvailable, so without the reset an
  // alarm-red readout from the old path survives onto the new one.
  it('clears the zone state on a re-point', () => {
    capturedNext?.({ ...update(142), state: States.Alarm } as IPathUpdate);
    expect(internals.currentState()).toBe(States.Alarm);

    options.set(makeConfig('self.navigation.headingMagnetic'));
    fixture.detectChanges();

    expect(internals.currentState()).toBe(States.Normal);
  });

  // The same effect re-runs on a theme change, so an unconditional clear would blink the needle
  // off and back on at every switch.
  it('shows the new path\'s heading immediately when it has one, without surfacing the clear', () => {
    capturedNext?.(update(142));

    replayOnObserve = update(271);
    options.set(makeConfig('self.navigation.headingMagnetic'));
    fixture.detectChanges();

    expect(internals.dataAvailable()).toBe(true);
    expect(internals.value()).toBe(271);
    expect(internals.textValue()).toBe('271');
  });

  it('keeps the heading when the config changes without changing the path', () => {
    capturedNext?.(update(142));
    const before = observeCount;

    fixture.componentRef.setInput('theme', {
      contrast: 'rgba(0,0,0,1)', contrastDim: 'rgba(60,60,60,1)',
      contrastDimmer: 'rgba(120,120,120,1)', cardColor: 'rgba(238,238,238,1)',
      background: 'rgba(255,255,255,1)', zoneAlarm: 'rgba(255,0,0,1)',
      zoneWarn: 'rgba(255,170,0,1)', zoneAlert: 'rgba(255,0,255,1)',
      zoneEmergency: 'rgba(255,0,0,1)'
    });
    fixture.detectChanges();

    // Positive control: the effect really did re-run, so "no clear" is a decision, not a no-op.
    expect(observeCount).toBeGreaterThan(before);
    expect(internals.dataAvailable()).toBe(true);
    expect(internals.value()).toBe(142);
    expect(internals.textValue()).toBe('142');
  });
});

/**
 * What the compass shows for a set of SI inputs: the value handed to the gauge, the readout and the
 * unit label. Pins the output so a change of the unit the widget computes in cannot move anything
 * on screen.
 */
describe('WidgetGaugeNgCompassComponent output from SI inputs', () => {
  let fixture: ComponentFixture<WidgetGaugeNgCompassComponent>;
  let next: ((u: IPathUpdate) => void) | undefined;

  interface CompassOutput {
    value: () => number | null | undefined;
    textValue: () => string;
    gaugeOptions: { minValue?: number; maxValue?: number; units?: string };
  }

  /** An SI sample as the streams directive delivers it to this widget, with its presentation measure. */
  const feed = (rad: number | null): void => {
    next?.({ data: { value: rad, timestamp: null, measure: 'deg' }, state: 'normal' } as IPathUpdate);
  };
  const feedDegrees = (deg: number): void => feed(deg * DEG);

  const shown = (): { value: number | null | undefined; text: string } => {
    const c = fixture.componentInstance as unknown as CompassOutput;
    const value = c.value();
    return { value: value == null ? value : Number(value.toFixed(6)), text: c.textValue() };
  };

  const render = (path: string): void => {
    const dflt = WidgetGaugeNgCompassComponent.DEFAULT_CONFIG;
    const gaugePath = (dflt.paths as IPathArray)['gaugePath'];
    TestBed.configureTestingModule({
      imports: [WidgetGaugeNgCompassComponent],
      providers: [
        { provide: WidgetRuntimeDirective, useValue: { options: signal<IWidgetSvcConfig | undefined>({ ...dflt, paths: { gaugePath: { ...gaugePath, path } } }) } },
        { provide: WidgetStreamsDirective, useValue: { observe: (_p: string, n: (u: IPathUpdate) => void) => { next = n; }, useSiValues: () => undefined } },
        { provide: UnitsService, useValue: { getUnitDisplaySymbol: (m: string | null | undefined) => m === 'deg' ? '°' : (m ?? '') } }
      ]
    });
    fixture = TestBed.createComponent(WidgetGaugeNgCompassComponent);
    fixture.componentRef.setInput('id', 'compass-si');
    fixture.componentRef.setInput('type', 'widget-gauge-ng-compass');
    fixture.componentRef.setInput('theme', {
      contrast: 'rgba(255,255,255,1)', contrastDim: 'rgba(200,200,200,1)',
      contrastDimmer: 'rgba(150,150,150,1)', cardColor: 'rgba(17,17,17,1)',
      background: 'rgba(0,0,0,1)', zoneAlarm: 'rgba(255,0,0,1)',
      zoneWarn: 'rgba(255,170,0,1)', zoneAlert: 'rgba(255,0,255,1)',
      zoneEmergency: 'rgba(255,0,0,1)'
    });
    fixture.detectChanges();
  };

  beforeEach(() => { next = undefined; });

  it('hands the gauge a heading in degrees on a 0..360 dial labelled in degrees', () => {
    render('self.navigation.headingTrue');
    feedDegrees(142.4);

    const options = (fixture.componentInstance as unknown as CompassOutput).gaugeOptions;
    expect({ ...shown(), min: options.minValue, max: options.maxValue, units: options.units })
      .toEqual({ value: 142.4, text: '142', min: 0, max: 360, units: '°' });
  });

  it('turns a port-side wind angle into its 0..360 bearing', () => {
    render('self.environment.wind.angleApparent');
    feedDegrees(-30);
    expect(shown()).toEqual({ value: 330, text: '330' });
  });

  it('clamps a reading outside the dial on a path with no port-side convention', () => {
    render('self.navigation.headingTrue');
    feedDegrees(-10);
    expect(shown()).toEqual({ value: 0, text: '0' });
    feedDegrees(370);
    expect(shown()).toEqual({ value: 360, text: '360' });
  });

  it('parks the needle and shows the placeholder on a null', () => {
    render('self.navigation.headingTrue');
    feedDegrees(90);
    feed(null);
    expect(shown()).toEqual({ value: 0, text: '--' });
  });
});
