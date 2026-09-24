import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EMPTY } from 'rxjs';
import { Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetRacerLineComponent } from './widget-racer-line.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective } from '../../core/directives/widget-streams.directive';
import { SignalkRequestsService } from '../../core/services/signalk-requests.service';
import { DashboardService } from '../../core/services/dashboard.service';
import { CanvasService } from '../../core/services/canvas.service';
import { UnitsService } from '../../core/services/units.service';
import { IPathUpdate } from '../../core/services/data.service';
import { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';
import { ITheme } from '../../core/services/app-service';

const FEET_PER_M = 3.28084;

const unitsServiceStub = {
  getUnitDisplaySymbol: (measure: string | null | undefined) => measure === 'feet' ? 'ft' : (measure ?? ''),
  convertToUnit: (unit: string, value: number) => unit === 'feet' ? value * FEET_PER_M : value
};

const theme = {
  contrast: 'value', contrastDim: 'label', contrastDimmer: 'dimmer', cardColor: 'card',
  zoneAlarm: 'alarm', zoneWarn: 'warn', zoneAlert: 'alert'
} as unknown as ITheme;

/**
 * What the widget shows for a set of SI inputs: the canvas readouts (DTS with its colour and unit,
 * TTL, TTB) and the line length and bias under the canvas. Pins the output so a change of the unit
 * the widget computes in cannot move anything on screen.
 */
describe('WidgetRacerLineComponent output from SI inputs', () => {
  let fixture: ComponentFixture<WidgetRacerLineComponent>;
  let options: WritableSignal<IWidgetSvcConfig | undefined>;
  let callbacks: Map<string, (u: IPathUpdate) => void>;
  let drawText: Mock<CanvasService['drawText']>;

  /** An SI sample as the streams directive delivers it to this widget, with its presentation measure. */
  const feed = (pathKey: string, si: number | null, measure: string): void => {
    const callback = callbacks.get(pathKey);
    if (!callback) throw new Error(`${pathKey} is not observed`);
    callback({ data: { value: si, timestamp: null, measure }, state: 'normal' } as IPathUpdate);
  };

  /** The canvas readouts of the latest frame: DTS value and colour, its unit, TTL and TTB. */
  const canvasReadouts = () => {
    const frame = drawText.mock.calls.slice(-6).map(call => ({ text: call[1], color: call[7] as string }));
    expect(frame[2].text, 'frame layout').toBe('TTL');
    return { dts: frame[0].text, color: frame[0].color, unit: frame[1].text, ttl: frame[3].text, ttb: frame[5].text };
  };

  const lineReadouts = () => {
    fixture.detectChanges();
    const text = (selector: string) =>
      ((fixture.nativeElement as HTMLElement).querySelector(selector)?.textContent ?? '').trim();
    return { port: text('.pin-container'), length: text('.len-bias-container'), stbd: text('.boat-container') };
  };

  const render = (overrides: Partial<IWidgetSvcConfig> = {}): void => {
    options.set({ ...WidgetRacerLineComponent.DEFAULT_CONFIG, ...overrides });
    fixture = TestBed.createComponent(WidgetRacerLineComponent);
    fixture.componentRef.setInput('id', 'racer-line-test');
    fixture.componentRef.setInput('type', 'widget-racer-line');
    fixture.componentRef.setInput('theme', theme);
    fixture.detectChanges();
  };

  beforeEach(() => {
    options = signal<IWidgetSvcConfig | undefined>(undefined);
    callbacks = new Map<string, (u: IPathUpdate) => void>();
    drawText = vi.fn<CanvasService['drawText']>();
    const streamsMock = {
      observe: (pathName: string, next: (u: IPathUpdate) => void) => { callbacks.set(pathName, next); },
      unobserve: (pathName: string) => { callbacks.delete(pathName); },
      useSiValues: () => undefined
    };
    const canvasMock: Partial<CanvasService> = {
      clearCanvas: vi.fn(),
      createTitleBitmap: vi.fn(() => document.createElement('canvas')),
      drawText,
      drawTextBitmap: vi.fn(),
      registerCanvas: vi.fn(),
      unregisterCanvas: vi.fn(),
      MIN_LABEL_PX: 16,
      MIN_UNIT_PX: 12
    };
    TestBed.configureTestingModule({
      imports: [WidgetRacerLineComponent],
      providers: [
        { provide: WidgetRuntimeDirective, useValue: { options } },
        { provide: WidgetStreamsDirective, useValue: streamsMock },
        { provide: SignalkRequestsService, useValue: { subscribeRequest: () => EMPTY, putRequest: vi.fn() } },
        { provide: DashboardService, useValue: { isDashboardStatic: () => true } },
        { provide: CanvasService, useValue: canvasMock },
        { provide: UnitsService, useValue: unitsServiceStub }
      ]
    });
  });

  afterEach(() => fixture?.destroy());

  it('shows the distance to the line in metres with the configured decimals', () => {
    render({ numDecimal: 1 });
    feed('dtsPath', 123.44, 'm');
    expect(canvasReadouts()).toMatchObject({ dts: '123.4', unit: 'm', color: 'value' });
  });

  it('shows the distance to the line in feet when that is the presentation unit', () => {
    render();
    feed('dtsPath', 12.3, 'feet');
    expect(canvasReadouts()).toMatchObject({ dts: '40', unit: 'ft' });
  });

  it.each([
    ['m', -3, 'alarm'],
    ['m', 0, 'value'],
    ['m', 5, 'warn'],
    ['m', 10, 'alert'],
    ['m', 15, 'alert'],
    ['m', 20, 'value'],
    ['m', 25, 'value'],
    ['feet', -3, 'alarm'],
    ['feet', 5, 'warn'],
    ['feet', 10, 'alert'],
    ['feet', 15, 'alert'],
    ['feet', 20, 'value']
  ])('colours DTS %s at %d m %s: OCS below 0 m, warn below 10 m, alert below 20 m', (measure, metres, color) => {
    render();
    feed('dtsPath', metres as number, measure as string);
    expect(canvasReadouts().color).toBe(color);
  });

  it('shows placeholders before any distance or time arrives', () => {
    render();
    feed('dtsPath', null, 'm');
    expect(canvasReadouts()).toMatchObject({ dts: '--', ttl: '-:--', ttb: '-:--', color: 'value' });
  });

  it('formats time to line and time to burn from seconds', () => {
    render();
    feed('ttlPath', 65.7, 's');
    feed('ttbPath', -10, 's');
    expect(canvasReadouts()).toMatchObject({ ttl: '1:05', ttb: '-0:10' });
    feed('ttlPath', 3725, 's');
    expect(canvasReadouts().ttl).toBe('1:02:05');
  });

  it('shows the line length and bias in metres', () => {
    render();
    feed('lineLengthPath', 120.4, 'm');
    feed('lineBiasPath', 2.4, 'm');
    expect(lineReadouts()).toEqual({ port: '-2m', length: '⚑ ―120m― ⚑', stbd: '+2m' });
    feed('lineBiasPath', -6.2, 'm');
    expect(lineReadouts()).toEqual({ port: '+6m', length: '⚑ ―120m― ⚑', stbd: '-6m' });
  });

  it('shows the line length and bias in feet with a prime', () => {
    render();
    feed('lineLengthPath', 100, 'feet');
    feed('lineBiasPath', -4, 'feet');
    expect(lineReadouts()).toEqual({ port: '+13′', length: '⚑ ―328′― ⚑', stbd: '-13′' });
  });
});
