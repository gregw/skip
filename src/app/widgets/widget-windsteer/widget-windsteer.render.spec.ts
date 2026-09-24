import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetWindComponent } from './widget-windsteer.component';
import { SvgWindsteerComponent } from '../svg-windsteer/svg-windsteer.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective } from '../../core/directives/widget-streams.directive';
import { UnitsService } from '../../core/services/units.service';
import { IPathUpdate } from '../../core/services/data.service';
import { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';
import { ActivePolarService } from '../../core/services/active-polar.service';
import { Polar, toCanonicalPolarTable } from '../../core/utils/polar-engine.util';
import hurmaPolar from '../../core/utils/polar-engine.hurma-polar.fixture.json';

const DEG = Math.PI / 180;
const KNOTS_PER_MS = 1.94384;

const unitsServiceStub = {
  getUnitDisplaySymbol: (measure: string | null | undefined) => measure === 'knots' ? 'kn' : (measure ?? ''),
  convertToUnit: (unit: string, value: number) => {
    if (unit === 'knots') return value * KNOTS_PER_MS;
    if (unit === 'deg') return value / DEG;
    return value;
  }
};

const hurma = (() => {
  const result = toCanonicalPolarTable(hurmaPolar);
  if (!result.ok) throw new Error(result.reason);
  return new Polar(result.table);
})();

const readyPolar = {
  status: signal({ kind: 'ready' }),
  polar: signal(hurma),
  peakSpeed: signal(hurma.peakSpeed()),
  performanceFactor: signal(1),
  ensureStarted: () => undefined
};

/**
 * What the widget draws for a set of SI inputs, read from the rendered SVG: rotation attributes,
 * close-hauled line and wind-sector paths, and the text readouts. Pins the rendering so a change of
 * the unit the widget computes in cannot move anything on screen.
 */
describe('WidgetWindComponent rendering from SI inputs', () => {
  let fixture: ComponentFixture<WidgetWindComponent>;
  let options: WritableSignal<IWidgetSvcConfig | undefined>;
  let callbacks: Map<string, (u: IPathUpdate) => void>;

  const makeConfig = (overrides: Partial<IWidgetSvcConfig> = {}): IWidgetSvcConfig => ({
    ...WidgetWindComponent.DEFAULT_CONFIG,
    compassModeEnabled: true,
    windSectorEnable: true,
    ...overrides
  });

  /** An SI sample as the streams directive delivers it to this widget, with its presentation measure. */
  const feed = (pathKey: string, si: number, measure: string): void => {
    const callback = callbacks.get(pathKey);
    if (!callback) throw new Error(`${pathKey} is not observed`);
    callback({ data: { value: si, timestamp: null, measure }, state: 'normal' } as IPathUpdate);
  };
  const feedAngle = (pathKey: string, deg: number): void => feed(pathKey, deg * DEG, 'deg');
  const feedSpeed = (pathKey: string, ms: number): void => feed(pathKey, ms, 'knots');

  const svg = (): SvgWindsteerComponent =>
    fixture.debugElement.query(By.directive(SvgWindsteerComponent)).componentInstance as SvgWindsteerComponent;
  const rotation = (ref: string): string | null => {
    const element = (svg() as unknown as Record<string, () => { nativeElement: SVGGElement }>)[ref]().nativeElement;
    // Six decimals: a rad input converted to degrees for the attribute carries float noise.
    return element.getAttribute('transform')?.replace(/-?\d+\.\d+/g, n => String(Number(Number(n).toFixed(6)))) ?? null;
  };
  const attr = (selector: string, name: string): string | null =>
    (fixture.nativeElement as HTMLElement).querySelector(selector)?.getAttribute(name) ?? null;
  const text = (id: string): string =>
    ((fixture.nativeElement as HTMLElement).querySelector(`#${id}`)?.textContent ?? '').trim();

  /** Point count and coordinate sums of a path, to one decimal: compact enough to pin a long curve. */
  const pathSummary = (d: string | null): string => {
    const points: string[] = (d ?? '').match(/-?\d+(\.\d+)?,-?\d+(\.\d+)?/g) ?? [];
    const sum = points.reduce<[number, number]>(([sx, sy], point) => {
      const [x, y] = point.split(',').map(Number);
      return [sx + x, sy + y];
    }, [0, 0]);
    return `${points.length} points, Σx ${sum[0].toFixed(1)}, Σy ${sum[1].toFixed(1)}`;
  };

  /** Runs change detection and lets every rotation and path animation finish. */
  const settle = (): void => {
    fixture.detectChanges();
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
  };

  const render = (config: IWidgetSvcConfig): void => {
    options.set(config);
    fixture = TestBed.createComponent(WidgetWindComponent);
    fixture.componentRef.setInput('id', 'w1');
    fixture.componentRef.setInput('type', 'widget-wind-steer');
    fixture.componentRef.setInput('theme', null);
    TestBed.tick();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    options = signal<IWidgetSvcConfig | undefined>(undefined);
    callbacks = new Map<string, (u: IPathUpdate) => void>();
    const streamsMock = {
      observe: (pathName: string, next: (u: IPathUpdate) => void) => { callbacks.set(pathName, next); },
      unobserve: (pathName: string) => { callbacks.delete(pathName); }
    };
    TestBed.configureTestingModule({
      imports: [WidgetWindComponent],
      providers: [
        { provide: WidgetRuntimeDirective, useValue: { options } },
        { provide: WidgetStreamsDirective, useValue: streamsMock },
        { provide: UnitsService, useValue: unitsServiceStub },
        { provide: ActivePolarService, useValue: readyPolar }
      ]
    });
  });

  afterEach(() => {
    fixture?.destroy();
    vi.useRealTimers();
  });

  it('rotates the dial and indicators and places the close-hauled lines for HDG 350, TWA 40, close-hauled 45', () => {
    render(makeConfig());
    feedAngle('headingPath', 350);
    feedAngle('trueWindAngle', 40);
    feedAngle('appWindAngle', 30);
    feedAngle('courseOverGround', 355);
    feedAngle('nextWaypointBearing', 20);
    feedAngle('set', 90);
    feedSpeed('speedOverGround', 3);
    settle();

    expect({
      dial: rotation('rotatingDial'),
      twa: rotation('twaIndicator'),
      awa: rotation('awaIndicator'),
      cog: rotation('cogIndicator'),
      wpt: rotation('wptIndicator'),
      set: rotation('setIndicator'),
      port: attr('#PortCloseHauledLine', 'd'),
      stbd: attr('#StbdCloseHauledLine', 'd')
    }).toEqual({
      dial: 'rotate(10 500 500)',
      twa: 'rotate(40 500 500)',
      awa: 'rotate(30 500 500)',
      cog: 'rotate(5 500 500)',
      wpt: 'rotate(20 500 500)',
      set: 'rotate(100 904 912)',
      port: 'M 500,500 L 409,161',
      stbd: 'M 500,500 L 838,409'
    });
  });

  it('shows speeds in the presentation unit with its symbol', () => {
    render(makeConfig());
    feedSpeed('trueWindSpeed', 5.144);
    feedSpeed('appWindSpeed', 7.2);
    feedSpeed('drift', 0.5);
    feedAngle('headingPath', 10);
    settle();

    expect(text('text42')).toBe('10.0');
    expect(text('text43')).toBe('kn');
    expect(text('text40')).toBe('14.0');
    expect(text('text39')).toBe('kn');
    expect(text('driftValue')).toBe('1.0');
    expect(text('driftUnit')).toBe('kn');
  });

  it('spans the wind sector across north without a 358° swing', () => {
    render(makeConfig());
    feedAngle('headingPath', 0);
    feedAngle('trueWindAngle', 358);
    vi.advanceTimersByTime(200);
    feedAngle('trueWindAngle', 2);
    vi.advanceTimersByTime(1000);
    settle();

    const sectors = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('path'))
      .map(path => path.getAttribute('d') ?? '')
      .filter(d => d.includes(' A 350,350 '))
      .map(d => d.replace(/\d+\.\d+/g, n => Number(n).toFixed(1)));
    expect(sectors).toEqual([
      'M 500,500 L 244.0,261.3 A 350,350 0 0 1 261.3,244.0 z',
      'M 500,500 L 738.7,244.0 A 350,350 0 0 1 756.0,261.3 z'
    ]);
  });

  it('draws the rudder bar from a signed rudder angle', () => {
    render(makeConfig());
    feedAngle('headingPath', 0);
    feedAngle('rudderAngle', 17.5);
    settle();

    expect(attr('path.rudder-stbd', 'style')).toContain('stroke-dashoffset: 50');
    expect(attr('path.rudder-port', 'style')).toContain('stroke-dashoffset: 100');
  });

  it('draws the polar overlay: curve turned by the water TWA, VMC lobe toward the waypoint, and the dot', () => {
    render(makeConfig({ polarOverlayEnable: true, windSectorEnable: false }));
    feedAngle('headingPath', 30);
    feed('polarTrueWindSpeed', 5, 'm/s');
    feed('polarTrueWindAngle', 45 * DEG, 'rad');
    feed('polarSpeedThroughWater', 3, 'm/s');
    settle();

    const polarRotation = rotation('polarOverlay');
    const polarDot = Number(attr('circle.polar-dot', 'cy')).toFixed(3);

    feedAngle('nextWaypointBearing', 10);
    settle();

    expect({
      polarRotation,
      polarDot,
      vmc: pathSummary(attr('path.vmc-curve', 'd')),
      vmcDot: Number(attr('circle.polar-dot', 'cy')).toFixed(3)
    }).toEqual({
      polarRotation: 'rotate(45 500 500)',
      polarDot: '249.234',
      vmc: '180 points, Σx 88685.4, Σy 79998.0',
      vmcDot: '264.357'
    });
  });
});
