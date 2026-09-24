import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EMPTY } from 'rxjs';
import { Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetRacerTimerComponent } from './widget-racer-timer.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective } from '../../core/directives/widget-streams.directive';
import { SignalkRequestsService } from '../../core/services/signalk-requests.service';
import { ToastService } from '../../core/services/toast.service';
import { DashboardService } from '../../core/services/dashboard.service';
import { CanvasService } from '../../core/services/canvas.service';
import { IPathUpdate } from '../../core/services/data.service';
import { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';
import { ITheme } from '../../core/services/app-service';

const theme = {
  contrast: 'value', contrastDim: 'label', contrastDimmer: 'dimmer', cardColor: 'card',
  zoneAlarm: 'alarm', zoneWarn: 'warn', zoneAlert: 'alert'
} as unknown as ITheme;

/**
 * What the widget shows for a set of SI inputs: the time to start, its colour (including OCS from
 * the distance to the line) and the controls offered at the gun. Pins the output so a change of the
 * unit the widget computes in cannot move anything on screen.
 */
describe('WidgetRacerTimerComponent output from SI inputs', () => {
  let fixture: ComponentFixture<WidgetRacerTimerComponent>;
  let options: WritableSignal<IWidgetSvcConfig | undefined>;
  let callbacks: Map<string, (u: IPathUpdate) => void>;
  let drawText: Mock<CanvasService['drawText']>;

  /** An SI sample as the streams directive delivers it to this widget, with its presentation measure. */
  const feed = (pathKey: string, si: number | null, measure: string): void => {
    const callback = callbacks.get(pathKey);
    if (!callback) throw new Error(`${pathKey} is not observed`);
    callback({ data: { value: si, timestamp: null, measure }, state: 'normal' } as IPathUpdate);
  };
  const feedTts = (seconds: number | null): void => feed('ttsPath', seconds, 's');
  const feedDts = (metres: number | null): void => feed('dtsPath', metres, 'm');

  /** The time-to-start readout of the latest frame and its colour. */
  const readout = () => {
    const call = drawText.mock.calls.at(-1);
    return { text: call?.[1], color: call?.[7] as string };
  };
  const buttons = (): string[] => {
    fixture.detectChanges();
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')]
      .map(button => button.textContent?.trim() ?? '')
      .filter(label => label !== '⋮');
  };

  const render = (): void => {
    options.set({ ...WidgetRacerTimerComponent.DEFAULT_CONFIG, playBeeps: false });
    fixture = TestBed.createComponent(WidgetRacerTimerComponent);
    fixture.componentRef.setInput('id', 'racer-timer-test');
    fixture.componentRef.setInput('type', 'widget-racer-timer');
    fixture.componentRef.setInput('theme', theme);
    fixture.detectChanges();
  };

  beforeEach(() => {
    options = signal<IWidgetSvcConfig | undefined>(undefined);
    callbacks = new Map<string, (u: IPathUpdate) => void>();
    drawText = vi.fn<CanvasService['drawText']>();
    const streamsMock = {
      observe: (pathName: string, next: (u: IPathUpdate) => void) => { callbacks.set(pathName, next); },
      unobserve: (pathName: string) => { callbacks.delete(pathName); }
    };
    const canvasMock: Partial<CanvasService> = {
      clearCanvas: vi.fn(),
      createTitleBitmap: vi.fn(() => document.createElement('canvas')),
      drawText,
      drawTextBitmap: vi.fn(),
      registerCanvas: vi.fn(),
      unregisterCanvas: vi.fn(),
      MIN_LABEL_PX: 16
    };
    TestBed.configureTestingModule({
      imports: [WidgetRacerTimerComponent],
      providers: [
        { provide: WidgetRuntimeDirective, useValue: { options } },
        { provide: WidgetStreamsDirective, useValue: streamsMock },
        { provide: SignalkRequestsService, useValue: { subscribeRequest: () => EMPTY, putRequest: vi.fn() } },
        { provide: DashboardService, useValue: { isDashboardStatic: () => true } },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: CanvasService, useValue: canvasMock }
      ]
    });
  });

  afterEach(() => fixture?.destroy());

  it('shows a placeholder before the time to start arrives', () => {
    render();
    feedTts(null);
    expect(readout()).toEqual({ text: '-:--', color: 'value' });
  });

  it.each([
    [3725, '1:02:05', 'value'],
    [90, '1:30', 'value'],
    [60, '1:00', 'value'],
    [59.5, '0:59', 'alert'],
    [10, '0:10', 'alert'],
    [9, '0:09', 'warn'],
    [0.4, '0:00', 'warn'],
    [-12, '-0:12', 'warn']
  ])('shows %d s to the start as %s in %s: alert below 60 s, warn below 10 s', (seconds, text, color) => {
    render();
    feedDts(25);
    feedTts(seconds as number);
    expect(readout()).toEqual({ text, color });
  });

  it.each([
    [-0.5, 'alarm'],
    [0, 'warn'],
    [4, 'warn']
  ])('in the last 10 s marks the boat OCS when the distance to the line is %d m: %s', (metres, color) => {
    render();
    feedDts(metres as number);
    feedTts(5);
    expect(readout().color).toBe(color);
  });

  it('at the gun shows OCS in alarm and switches to the sync and reset controls', () => {
    render();
    feedDts(-2);
    feedTts(1);
    feedTts(0);
    expect(readout()).toEqual({ text: '0:00', color: 'alarm' });
    expect(buttons()).toEqual(['Sync', 'Reset']);
  });

  it('at the gun behind the line keeps the value colour', () => {
    render();
    feedDts(3);
    feedTts(0);
    expect(readout()).toEqual({ text: '0:00', color: 'value' });
    expect(buttons()).toEqual(['Sync', 'Reset']);
  });
});
