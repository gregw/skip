import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetRacerLineViewComponent } from './widget-racer-line-view.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective } from '../../core/directives/widget-streams.directive';
import { UnitsService } from '../../core/services/units.service';
import { SignalkRequestsService } from '../../core/services/signalk-requests.service';
import { DashboardService } from '../../core/services/dashboard.service';
import { signal } from '@angular/core';

/**
 * The widget subscribes and hands the values down; the drawing turns them into SVG. These tests
 * drive it from the stream callbacks, which is the seam a real Signal K delta arrives at, and
 * assert on the rendered SVG — so they cover the whole path rather than the geometry alone, which
 * `start-line-geometry.util.spec.ts` already covers on its own.
 */
describe('WidgetRacerLineViewComponent', () => {
  let fixture: ComponentFixture<WidgetRacerLineViewComponent>;
  /** The callback the widget registered per path key, so a test can push values in. */
  let feeds: Map<string, (pkt: unknown) => void>;

  const runtimeMock = { options: () => WidgetRacerLineViewComponent.DEFAULT_CONFIG };
  const requestsMock = { putRequest: vi.fn() };
  // Only the lock state is read, and a locked dashboard is the state the controls are
  // usable in; unlocked covers them with the drag overlay.
  const dashboardMock = { isDashboardStatic: signal(true) };
  const unitsMock: Partial<UnitsService> = {
    convertToUnit: vi.fn((_unit: string, value: number) => value),
    getUnitDisplaySymbol: vi.fn((measure: string | null | undefined) => measure ?? '')
  };

  beforeEach(async () => {
    feeds = new Map();
    requestsMock.putRequest.mockClear();
    const streamsMock = {
      observe: vi.fn((key: string, cb: (pkt: unknown) => void) => { feeds.set(key, cb); })
    };

    await TestBed.configureTestingModule({
      imports: [WidgetRacerLineViewComponent],
      providers: [
        { provide: WidgetRuntimeDirective, useValue: runtimeMock },
        { provide: WidgetStreamsDirective, useValue: streamsMock },
        { provide: UnitsService, useValue: unitsMock },
        { provide: SignalkRequestsService, useValue: requestsMock },
        { provide: DashboardService, useValue: dashboardMock }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(WidgetRacerLineViewComponent);
    const set = fixture.componentRef.setInput.bind(fixture.componentRef) as (k: string, v: unknown) => void;
    set('id', 'racer-line-view-test');
    set('type', 'widget-racer-line-view');
    set('theme', null);
    fixture.detectChanges();
  });

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const svg = () => host().querySelector('svg.line-svg');

  const feed = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
      const cb = feeds.get(key);
      expect(cb, `nothing observed ${key}`).toBeTruthy();
      cb?.({ data: { value, timestamp: new Date() } });
    }
    fixture.detectChanges();
  };

  /**
   * A 140m line bearing 070, with the boat placed the way the delta service delivers a
   * position — one whole {latitude, longitude} object in degrees, at its own path. Object
   * values are never flattened into dotted child paths (SK-02 / #21), so there is no
   * navigation.position.latitude to feed. The pre-start side lies north-west of the line.
   */
  const aLine = (boatLat: number, boatLon: number) => feed({
    portPath: { latitude: 0.00043, longitude: 0.00118 },
    stbPath: { latitude: 0, longitude: 0 },
    lineLengthPath: 140,
    positionPath: { latitude: boatLat, longitude: boatLon },
    headingPath: 1.6, cogPath: 1.6, sogPath: 2.0
  });

  /**
   * The regression that shipped: every position was subscribed as a fabricated leaf path
   * (navigation.position.latitude and the two line ends' own), which the delta service
   * never emits, so a line that was set everywhere else read as no line at all here.
   */
  it('takes compound values whole, not as fabricated child paths', () => {
    // Signal K emits each of these as one object at its own path; a dotted child of one
    // is a path the delta service never emits (SK-02 / #21).
    const compound = [
      'self.navigation.position',
      'self.navigation.racing.startLinePort',
      'self.navigation.racing.startLineStb',
      'self.navigation.racing.lines'
    ];
    const paths = WidgetRacerLineViewComponent.DEFAULT_CONFIG.paths ?? {};
    for (const [key, cfg] of Object.entries(paths)) {
      const path = cfg.path ?? '';
      for (const root of compound) {
        expect(path.startsWith(root + '.'), `${key} subscribes to a child of ${root}`).toBe(false);
      }
    }
  });

  /**
   * Signal K's unit preferences file a metre-valued path under the 'distance' category,
   * which every nautical preset targets at nautical miles — so a 140m start line renders
   * as 0. These are boat-scale measurements and keep the widget's own unit.
   */
  it('draws every distance in the unit the length stream resolved to', () => {
    // The pipeline converts to the server's preferred unit and reports it as `measure`;
    // reading the stored convertUnitTo instead is how the legs came to be drawn in metres
    // beside a line length in another unit.
    aLine(0.00035, 0.00030);
    (unitsMock.convertToUnit as unknown as { mockClear: () => void }).mockClear();
    feeds.get('lineLengthPath')?.({ data: { value: 140, measure: 'foot', timestamp: new Date() } });
    fixture.detectChanges();
    const units = (unitsMock.convertToUnit as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.map(c => c[0]);
    // 'knots' also appears: the VMGs are speeds and have their own unit. What must not
    // appear is 'm' — a distance still being drawn in the stored unit.
    expect(units, 'the resolved unit was never used').toContain('foot');
    expect(units, 'a distance was drawn in the stored unit').not.toContain('m');
  });

  it('measures the line itself rather than converting the published length twice', () => {
    // The published length arrives already converted; the drawing converts metres once.
    aLine(0.00035, 0.00030);
    feeds.get('lineLengthPath')?.({ data: { value: 99999, measure: 'm', timestamp: new Date() } });
    fixture.detectChanges();
    expect(svg()?.querySelector('.line-label')?.textContent).not.toContain('99999');
    expect(svg()?.querySelector('.line-label')?.textContent).toContain('140');
  });

  /**
   * The line is published when it changes and then not again, so the widget-wide 5s
   * stale-data TTL would null it moments after it arrived. Everything describing the line
   * has to sit outside that timeout; the live readings stay inside it.
   */
  it('keeps the line’s own state out of the stale-data timeout', () => {
    const paths = WidgetRacerLineViewComponent.DEFAULT_CONFIG.paths ?? {};
    for (const key of ['portPath', 'stbPath', 'lineLengthPath', 'lineBearingPath',
      'startLineNamePath', 'linesPath', 'boatLengthPath']) {
      expect(paths[key]?.enableTimeout, `${key} would be timed out`).toBe(false);
    }
    for (const key of ['positionPath', 'headingPath', 'cogPath', 'sogPath', 'twdPath']) {
      expect(paths[key]?.enableTimeout, `${key} should keep the timeout`).toBeUndefined();
    }
  });

  it('subscribes to every path its config declares', () => {
    const declared = Object.keys(WidgetRacerLineViewComponent.DEFAULT_CONFIG.paths ?? {});
    expect(declared.length).toBeGreaterThan(0);
    for (const key of declared) {
      expect(feeds.has(key), `never observed ${key}`).toBe(true);
    }
  });

  it('says so rather than drawing nothing when no line is set', () => {
    expect(svg()?.textContent).toContain('No start line set');
  });

  it('draws the line, both ends and the boat once a line and a fix arrive', () => {
    aLine(-0.00005, 0.00030);
    expect(svg()?.querySelector('.start-line')).toBeTruthy();
    expect(svg()?.querySelector('.port-mark')).toBeTruthy();
    expect(svg()?.querySelector('.stb-mark')).toBeTruthy();
    expect(svg()?.querySelector('.boat')).toBeTruthy();
    expect(svg()?.textContent).not.toContain('No start line set');
  });

  it('labels the line with its length and the heading sailed to cross it', () => {
    aLine(-0.00005, 0.00030);
    const label = svg()?.querySelector('.line-label')?.textContent ?? '';
    // "140m · 160°T↑" — the arrow says the heading is the way to sail to start.
    expect(label).toMatch(/^\d+m · \d{3}°T↑$/);
  });

  it('draws the start zone it decides the approach against', () => {
    aLine(-0.00005, 0.00030);
    // Two line extensions plus a 45 degree wedge either side of each end.
    expect(svg()?.querySelectorAll('.zone-guide')).toHaveLength(6);
  });

  it('closes the line straight across from inside the zone, and turns a corner outside it', () => {
    // Abeam the line: one leg only, the perpendicular one.
    aLine(-0.00005, 0.00030);
    expect(svg()?.querySelectorAll('.dimension')).toHaveLength(1);

    // Well past the pin: the along-line leg to the wedge appears beside it.
    aLine(0.00090, 0.00200);
    expect(svg()?.querySelectorAll('.dimension')).toHaveLength(2);
  });

  /**
   * The position Signal K reports is the bow, so the hull hangs aft of it: turning the
   * boat swings the stern around a bow that stays where it is.
   */
  it('rotates the boat about the bow, not its middle', () => {
    aLine(0.00035, 0.00030);
    const bow = () => {
      // The hull path starts at the bow: "M<x>,<y> C..."
      const d = svg()!.querySelector('.boat')!.getAttribute('d') ?? '';
      const m = /^M([\d.-]+),([\d.-]+)/.exec(d);
      expect(m, `no bow in ${d.slice(0, 40)}`).toBeTruthy();
      return { x: Number(m![1]), y: Number(m![2]) };
    };
    const before = bow();
    // A quarter turn, with the position untouched.
    feed({ headingPath: 1.6 + Math.PI / 2 });
    const after = bow();
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  describe('the line\u2019s own colour', () => {
    const lineClasses = () => [...(svg()!.querySelector('.start-line')!.classList)];
    /** The pre-start side lies north-west of the line; the course side is over it. */
    const behind = () => aLine(0.00035, 0.00030);
    const over = () => aLine(-0.00005, 0.00030);

    it('stays plain while the boat is behind the line', () => {
      feed({ startTimePath: '2026-01-01T10:00:00Z', ttsPath: 120 });
      behind();
      expect(lineClasses()).not.toContain('ocs');
      expect(lineClasses()).not.toContain('started');
    });

    it('goes red whenever the boat is over the line', () => {
      feed({ startTimePath: '2026-01-01T10:00:00Z', ttsPath: 120 });
      over();
      expect(lineClasses()).toContain('ocs');
      // And clears again the moment the boat gets back behind it.
      behind();
      expect(lineClasses()).not.toContain('ocs');
    });

    it('goes red with no countdown running at all: being over is a fact, not a phase', () => {
      over();
      expect(lineClasses()).toContain('ocs');
    });

    it('goes green at the gun when the boat was behind, and holds it', () => {
      feed({ startTimePath: '2026-01-01T10:00:00Z', ttsPath: 5 });
      behind();
      feed({ ttsPath: 0 });
      expect(lineClasses()).toContain('started');
      // The plugin stops publishing timeToStart at the gun and the widget's timeout
      // nulls it; crossing the line afterwards is just starting.
      feed({ ttsPath: null });
      over();
      expect(lineClasses()).toContain('started');
      expect(lineClasses()).not.toContain('ocs');
    });

    it('stays red rather than going green when the boat was over at the gun', () => {
      feed({ startTimePath: '2026-01-01T10:00:00Z', ttsPath: 5 });
      over();
      feed({ ttsPath: 0 });
      expect(lineClasses()).not.toContain('started');
      expect(lineClasses()).toContain('ocs');
    });

    it('goes plain again when the timer is reset', () => {
      feed({ startTimePath: '2026-01-01T10:00:00Z', ttsPath: 5 });
      behind();
      feed({ ttsPath: 0 });
      expect(lineClasses()).toContain('started');
      // A reset nulls startTime and re-seeds the countdown.
      feed({ startTimePath: null, ttsPath: 300 });
      expect(lineClasses()).not.toContain('started');
      expect(lineClasses()).not.toContain('ocs');
      // And with the latch gone, being over the line reads red again.
      over();
      expect(lineClasses()).toContain('ocs');
    });
  });

  it('draws the boat as one solid hull scaled to the vessel length', () => {
    aLine(0.00035, 0.00030);
    const boat = svg()!.querySelector('.boat')!;
    const d = boat.getAttribute('d') ?? '';
    // One closed outline, not the two nested ones the even-odd band needed.
    expect(d.match(/Z/g) ?? [], 'more than one hull outline').toHaveLength(1);
    expect(getComputedStyle(boat).fillRule).not.toBe('evenodd');
  });

  /**
   * In the last seconds the helm is reading the boat against the line, so the view holds
   * still — but never at the cost of drawing the boat outside the frame.
   */
  it('stops re-fitting the view inside the freeze window', () => {
    feed({ startTimePath: '2026-01-01T10:00:00Z' });
    aLine(0.00035, 0.00030);
    feed({ ttsPath: 300 });
    const early = svg()!.querySelector('.start-line')!.getAttribute('x1');
    // A long way out: far enough that a re-fit would visibly rescale.
    aLine(0.00500, 0.00030);
    expect(svg()!.querySelector('.start-line')!.getAttribute('x1'),
      'the view did not re-fit outside the freeze window').not.toBe(early);

    feed({ ttsPath: 10 });
    const frozen = svg()!.querySelector('.start-line')!.getAttribute('x1');
    aLine(0.00450, 0.00030);
    expect(svg()!.querySelector('.start-line')!.getAttribute('x1'),
      'the view re-fitted inside the freeze window').toBe(frozen);
  });

  it('marks the first leg of a two-leg approach so the pair reads in order', () => {
    // Outside the wedge: the approach turns a corner, so there are two legs.
    aLine(0.00120, 0.00300);
    const legs = [...svg()!.querySelectorAll('.dimension')];
    expect(legs.length, 'expected a two-leg approach').toBe(2);
    expect(legs[0].classList.contains('leading')).toBe(true);
    expect(legs[1].classList.contains('leading')).toBe(false);
  });

  it('flags the boat as OCS only when it is on the course side', () => {
    // The line bears 070, so the pre-start side lies to its north-west: 25m clear of it here.
    aLine(0.00035, 0.00030);
    expect(svg()?.querySelector('.boat')?.classList.contains('ocs')).toBe(false);
    // Across to the course side, 17m over.
    aLine(-0.00005, 0.00030);
    expect(svg()?.querySelector('.boat')?.classList.contains('ocs')).toBe(true);
  });

  it('shows the wind against the line only once a direction is known', () => {
    aLine(-0.00005, 0.00030);
    expect(svg()?.querySelector('.wind-arrow')).toBeNull();
    feed({ twdPath: 0.6 });
    expect(svg()?.querySelector('.wind-arrow')).toBeTruthy();
  });

  it('renders nothing in the drawing the accessibility tree would announce as a control', () => {
    aLine(-0.00005, 0.00030);
    // Watching the line: the drawing is inert, and the Edit button is the only control.
    expect(svg()?.querySelector('[tabindex]')).toBeNull();
    const buttons = [...host().querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map(b => b.textContent?.trim())).toEqual(['Edit']);
  });

  const editButton = () => [...host().querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent?.trim() === 'Edit');

  const setEditing = (on: boolean) => {
    (fixture.componentInstance as unknown as { editMode: { set: (v: boolean) => void } })
      .editMode.set(on);
    fixture.detectChanges();
  };

  describe('edit mode', () => {
    it('offers only the Edit button until editing', () => {
      aLine(0.00035, 0.00030);
      expect(host().querySelectorAll('button')).toHaveLength(1);
      expect(editButton(), 'no Edit button').toBeTruthy();
      expect(svg()?.querySelectorAll('.end-target')).toHaveLength(0);
    });

    it('goes in and out on the one button, which says which way it goes', () => {
      aLine(0.00035, 0.00030);
      editButton()!.click();
      fixture.detectChanges();
      expect(fixture.componentInstance['editMode']()).toBe(true);
      expect(editButton(), 'still offering Edit while editing').toBeFalsy();

      const done = [...host().querySelectorAll<HTMLButtonElement>('button')]
        .find(b => b.textContent?.trim() === 'Done');
      expect(done, 'no Done button').toBeTruthy();
      done!.click();
      fixture.detectChanges();
      expect(fixture.componentInstance['editMode']()).toBe(false);
      expect(editButton(), 'no Edit button after Done').toBeTruthy();
    });

    it('hides its controls behind the drag overlay while the dashboard is unlocked', () => {
      aLine(0.00035, 0.00030);
      expect(host().querySelector('.widgetOverlay')).toBeNull();
      dashboardMock.isDashboardStatic.set(false);
      fixture.detectChanges();
      expect(host().querySelector('.widgetOverlay')).toBeTruthy();
      dashboardMock.isDashboardStatic.set(true);
      fixture.detectChanges();
    });

    /**
     * The case edit mode exists for: no line yet, so there is nothing to draw and nothing
     * to press. It still has to offer both ends, or the ends can never be set.
     */
    it('draws a line to press when none is set, with both ends greyed', () => {
      setEditing(true);
      expect(svg()?.textContent).not.toContain('No start line set');
      expect(svg()?.querySelector('.start-line')).toBeTruthy();
      expect(svg()?.querySelectorAll('.end-target')).toHaveLength(2);
      expect(svg()?.querySelector('.port-mark.undefined')).toBeTruthy();
      expect(svg()?.querySelector('.stb-mark.undefined')).toBeTruthy();
    });

    it('sets an end from that placeholder like any other', () => {
      setEditing(true);
      svg()!.querySelector<SVGElement>('.end-target.stb')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }));
      expect(requestsMock.putRequest).toHaveBeenCalledWith(
        'navigation.racing.setStartLine', { end: 'stb', position: 'bow' },
        'racer-line-view-test');
    });

    it('still draws nothing but the empty state when only watching', () => {
      expect(svg()?.textContent).toContain('No start line set');
      expect(svg()?.querySelector('.start-line')).toBeNull();
    });

    it('stops greying the ends once the line resolves', () => {
      setEditing(true);
      aLine(0.00035, 0.00030);
      expect(svg()?.querySelector('.port-mark.undefined')).toBeNull();
      expect(svg()?.querySelector('.stb-mark.undefined')).toBeNull();
    });

    it('puts a target on each end, larger than the mark it covers', () => {
      aLine(0.00035, 0.00030);
      setEditing(true);
      const targets = [...svg()!.querySelectorAll('.end-target')];
      expect(targets).toHaveLength(2);
      const pinRadius = Number(svg()!.querySelector('.port-mark')!.getAttribute('r'));
      for (const t of targets) {
        expect(Number(t.getAttribute('r'))).toBeGreaterThan(pinRadius);
      }
    });

    it('drops the boat and its approach so only the line is in play', () => {
      aLine(0.00035, 0.00030);
      feed({ twdPath: 0.6 });
      expect(svg()?.querySelector('.boat')).toBeTruthy();
      setEditing(true);
      expect(svg()?.querySelector('.boat')).toBeNull();
      expect(svg()?.querySelector('.dimension')).toBeNull();
      expect(svg()?.querySelector('.wind-arrow')).toBeNull();
      expect(svg()?.querySelector('.start-line')).toBeTruthy();
    });

    it('sets the end that was pressed, and only that end', () => {
      aLine(0.00035, 0.00030);
      setEditing(true);
      svg()!.querySelector<SVGElement>('.end-target.port')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }));
      expect(requestsMock.putRequest).toHaveBeenCalledTimes(1);
      expect(requestsMock.putRequest.mock.calls[0][0]).toBe('navigation.racing.setStartLine');
      expect(requestsMock.putRequest.mock.calls[0][1]).toEqual({ end: 'port', position: 'bow' });
    });

    it('lists the named lines with the current one marked, and switches on a press', () => {
      aLine(0.00035, 0.00030);
      // The directive extracts the sub-field before the callback, so a test feeds the
      // extracted value — the whole navigation.racing.lines object never reaches here.
      feeds.get('linesPath')?.({ data: { value: [{ startLineName: 'Race 1' }, { startLineName: 'Race 2' }] } });
      feeds.get('startLineNamePath')?.({ data: { value: 'Race 2' } });
      setEditing(true);
      const chips = [...host().querySelectorAll<HTMLButtonElement>('.line-button')]
        .map(b => b.textContent?.trim());
      expect(chips).toEqual(['Default', 'Race 1', 'Race 2']);
      const current = host().querySelector('.line-button.current');
      expect(current?.textContent?.trim()).toBe('Race 2');

      host().querySelectorAll<HTMLButtonElement>('.line-button')[1].click();
      expect(requestsMock.putRequest).toHaveBeenCalledWith(
        'navigation.racing.setStartLineName', { startLineName: 'Race 1' }, 'racer-line-view-test');
    });

    it('sends the default line as a cleared name, not the literal word', () => {
      aLine(0.00035, 0.00030);
      setEditing(true);
      host().querySelector<HTMLButtonElement>('.line-button')!.click();
      expect(requestsMock.putRequest).toHaveBeenCalledWith(
        'navigation.racing.setStartLineName', { startLineName: null }, 'racer-line-view-test');
    });
  });
});
