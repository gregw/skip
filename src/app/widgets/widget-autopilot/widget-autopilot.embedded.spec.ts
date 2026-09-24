import { Type, WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { By } from '@angular/platform-browser';
import { EMPTY, Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetAutopilotComponent } from './widget-autopilot.component';
import { WidgetNumericComponent } from '../widget-numeric/widget-numeric.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective } from '../../core/directives/widget-streams.directive';
import { SignalkRequestsService } from '../../core/services/signalk-requests.service';
import { DashboardService } from '../../core/services/dashboard.service';
import { UnitsService } from '../../core/services/units.service';
import { DataService, IPathUpdate } from '../../core/services/data.service';
import { WidgetService } from '../../core/services/widget.service';
import { AppService } from '../../core/services/app-service';
import { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';

interface NumericInternals {
  runtime: { options: () => IWidgetSvcConfig | undefined };
  getValueText: () => string;
  labelMeasure: () => string;
}

/** SI unit of each route readout's path, as the server's meta reports it. */
const PATH_UNITS: Record<string, string> = {
  'navigation.course.calcValues.distance': 'm',
  'navigation.course.calcValues.crossTrackError': 'm'
};

/**
 * The route readouts the autopilot embeds as numeric widgets. Each runs in its own embedded host
 * with its own streams directive, so this drives the real directive from SI path data and pins the
 * text each readout shows.
 */
describe('WidgetAutopilotComponent embedded route readouts', () => {
  let fixture: ComponentFixture<WidgetAutopilotComponent>;
  let options: WritableSignal<IWidgetSvcConfig | undefined>;
  let paths: Map<string, Subject<IPathUpdate>>;

  const pathData = (path: string): Subject<IPathUpdate> => {
    const key = path.replace(/^self\./, '');
    let subject = paths.get(key);
    if (!subject) {
      subject = new Subject<IPathUpdate>();
      paths.set(key, subject);
    }
    return subject;
  };

  /** An SI value as the server delivers it on a path. */
  const send = (path: string, si: number): void =>
    pathData(path).next({ data: { value: si, timestamp: new Date() }, state: 'normal' } as IPathUpdate);

  const readout = (displayName: string): { value: string; label: string } => {
    const numerics = fixture.debugElement.queryAll(By.directive(WidgetNumericComponent))
      .map(el => el.componentInstance as NumericInternals);
    const numeric = numerics.find(n => n.runtime.options()?.displayName === displayName);
    if (!numeric) throw new Error(`${displayName} is not rendered`);
    return { value: numeric.getValueText(), label: numeric.labelMeasure() };
  };

  beforeEach(async () => {
    options = signal<IWidgetSvcConfig | undefined>(undefined);
    paths = new Map<string, Subject<IPathUpdate>>();
    const dataFake = {
      subscribePath: vi.fn(() => EMPTY),
      acquirePath: (path: string) => ({ data$: pathData(path).asObservable(), release: () => undefined }),
      getPathMetaObservable: () => of(null),
      getPathUnitType: (path: string) => PATH_UNITS[path.replace(/^self\./, '')] ?? null,
      getPathDisplayUnits: () => undefined,
      timeoutPathObservable: () => undefined
    };
    TestBed.configureTestingModule({
      imports: [WidgetAutopilotComponent],
      providers: [
        { provide: WidgetRuntimeDirective, useValue: { options } },
        {
          provide: WidgetStreamsDirective,
          useValue: { observe: () => undefined, unobserve: () => undefined }
        },
        { provide: SignalkRequestsService, useValue: { subscribeRequest: () => EMPTY, putRequest: vi.fn() } },
        { provide: HttpClient, useValue: { post: vi.fn(() => of({ statusCode: 200 })), put: vi.fn(() => of({ statusCode: 200 })), delete: vi.fn(() => of({ statusCode: 200 })) } },
        { provide: DashboardService, useValue: { isDashboardStatic: () => true } },
        { provide: DataService, useValue: dataFake },
        UnitsService,
        {
          provide: WidgetService,
          useValue: {
            getComponentType: (type: string) =>
              Promise.resolve(type === 'widget-numeric' ? WidgetNumericComponent as Type<unknown> : undefined)
          }
        },
        { provide: AppService, useValue: { cssThemeColorRoles$: of({ cardColor: '#000', contrast: '#fff', contrastDim: '#aaa' }) } }
      ]
    });
    const defaults = structuredClone(WidgetAutopilotComponent.DEFAULT_CONFIG);
    options.set({
      ...defaults,
      autopilot: { ...defaults.autopilot, apiVersion: 'v2', instanceId: 'test-autopilot', pluginId: 'autopilot', modes: ['auto', 'route'] }
    } as IWidgetSvcConfig);
    fixture = TestBed.createComponent(WidgetAutopilotComponent);
    fixture.componentRef.setInput('id', 'w1');
    fixture.componentRef.setInput('type', 'widget-autopilot');
    fixture.componentRef.setInput('theme', null);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('shows the distance to waypoint in its stored unit before the server names one', () => {
    send('self.navigation.course.calcValues.distance', 4630);
    expect(readout('DTWpt')).toEqual({ value: '2.5', label: 'nm' });
  });

  it('shows the cross-track error in metres', () => {
    send('self.navigation.course.calcValues.crossTrackError', -12.34);
    expect(readout('XTE')).toEqual({ value: '-12.3', label: 'm' });
  });
});
