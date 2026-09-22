import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked
} from '@angular/core';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective } from '../../core/directives/widget-streams.directive';
import { SignalkRequestsService } from '../../core/services/signalk-requests.service';
import { DashboardService } from '../../core/services/dashboard.service';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { IWidgetPath, IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';
import { ITheme } from '../../core/services/app-service';
import { getColors } from '../../core/utils/themeColors.utils';
import {
  IRacerLineViewData,
  NO_VMG,
  RacerLineViewComponent,
  VMG_NAMES
} from './racer-line-view/racer-line-view.component';

/**
 * The start line, drawn at full frame.
 *
 * Watching the line is the default state: the drawing, and one Edit button in the lower
 * left. Edit switches to editing, where the two ends become touch targets that put an end
 * on the vessel's current position, a row of buttons picks the named line to work on, and
 * the same button reads Done to come back. Nothing else is offered here - the numbers, the
 * favoured end, and editing the best VMGs stay in the Racer - Start Line Setup widget.
 *
 * The drawing itself sits in the child directory rather than here, so it stays a
 * self-contained component: if a second widget ever needs it again it lifts back out
 * unchanged.
 */
@Component({
  selector: 'widget-racer-line-view',
  templateUrl: './widget-racer-line-view.component.html',
  styleUrls: ['./widget-racer-line-view.component.scss'],
  imports: [RacerLineViewComponent, MatButtonModule, MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class WidgetRacerLineViewComponent {
  public id = input.required<string>();
  public type = input.required<string>();
  public theme = input.required<ITheme | null>();

  protected readonly runtime = inject(WidgetRuntimeDirective);
  private readonly streams = inject(WidgetStreamsDirective);
  private readonly signalk = inject(SignalkRequestsService);
  protected readonly dashboard = inject(DashboardService);

  public static readonly DEFAULT_CONFIG: IWidgetSvcConfig = {
    supportAutomaticHistoricalSeries: false,
    displayName: 'Start Line',
    filterSelfPaths: true,
    numDecimal: 1,
    updateInterval: 500,
    viewSmoothing: 10,
    viewFreezeSeconds: 15,
    color: 'contrast',
    enableTimeout: true,
    dataTimeout: 5,
    paths: {
      // The plugin publishes one object at navigation.racing.lines holding both the
      // current line's name and the list of known lines, so both keys point at it and
      // pick their field out with observe()'s subField.
      startLineNamePath: {
        description: 'The current named start line',
        path: 'self.navigation.racing.lines',
        source: 'default',
        pathType: 'object',
        pathRequired: false,
        isPathConfigurable: false,
        enableTimeout: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: null
      },
      linesPath: {
        description: 'The known named lines',
        path: 'self.navigation.racing.lines',
        source: 'default',
        pathType: 'object',
        pathRequired: false,
        isPathConfigurable: false,
        enableTimeout: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: null
      },
      portPath: {
        description: 'Position of the port (pin) end of the start line',
        path: 'self.navigation.racing.startLinePort',
        source: 'default', pathType: 'object', pathRequired: false, isPathConfigurable: false,
        showPathSkUnitsFilter: false, pathSkUnitsFilter: null,
        enableTimeout: false
      },
      stbPath: {
        description: 'Position of the starboard (boat) end of the start line',
        path: 'self.navigation.racing.startLineStb',
        source: 'default', pathType: 'object', pathRequired: false, isPathConfigurable: false,
        showPathSkUnitsFilter: false, pathSkUnitsFilter: null,
        enableTimeout: false
      },
      positionPath: {
        description: 'Position of the vessel',
        path: 'self.navigation.position',
        source: 'default', pathType: 'object', pathRequired: false, isPathConfigurable: false,
        showPathSkUnitsFilter: false, pathSkUnitsFilter: null
      },
      headingPath: {
        description: 'True heading of the vessel',
        path: 'self.navigation.headingTrue',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'rad', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad'
      },
      twdPath: {
        description: 'True wind direction',
        path: 'self.environment.wind.directionTrue',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'rad', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad'
      },
      cogPath: {
        description: 'Course over ground (true) of the vessel',
        path: 'self.navigation.courseOverGroundTrue',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'rad', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad'
      },
      sogPath: {
        // Kept in m/s: the projections are metres on the ground, not a readout.
        description: 'Speed over ground of the vessel',
        path: 'self.navigation.speedOverGround',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'm/s', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s'
      },
      lineLengthPath: {
        description: 'Length of the start line',
        path: 'self.navigation.racing.startLineLength',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        // Follows the server's unit preference for the path. Whatever that resolves to is
        // the unit the whole drawing measures in - see lengthUnit - so the line and the
        // approach legs always agree, whichever unit the server hands back.
        convertUnitTo: 'm', showConvertUnitTo: true, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm',
        enableTimeout: false
      },
      lineBearingPath: {
        description: 'Bearing of the start line',
        path: 'self.navigation.racing.startLineBearing',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'rad', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        enableTimeout: false
      },
      ttsPath: {
        description: 'Time to the start in seconds',
        path: 'self.navigation.racing.timeToStart',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 's', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 's'
      },
      startTimePath: {
        // Cleared by the plugin whenever the timer is not counting down, so it
        // doubles as the running flag.
        description: 'Time of the start',
        path: 'self.navigation.racing.startTime',
        source: 'default', pathType: 'Date', pathRequired: false, isPathConfigurable: false,
        enableTimeout: false
      },
      boatLengthPath: {
        // Drawn to the same scale as the line, so the triangle is the vessel's real size.
        description: 'Overall length of the vessel',
        path: 'self.design.length.overall',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'm', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm',
        enableTimeout: false
      },
      effectiveVmgToLinePath: {
        // What the plugin's time to line actually divides the perpendicular leg by:
        // the collected best, or the VMG being sailed now if that is better. Published
        // from signalk-racer 1.3.0; derived locally when it is absent.
        description: 'VMG the perpendicular leg of the time to line is divided by',
        path: 'self.navigation.racing.effectiveVmg.toLine',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'm/s', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        enableTimeout: false
      },
      effectiveVmgAlongLinePath: {
        description: 'VMG the along-line leg of the time to line is divided by',
        path: 'self.navigation.racing.effectiveVmg.alongLine',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'm/s', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        enableTimeout: false
      },
      vmgToCourseSidePath: {
        description: 'Best VMG across the line towards the course side',
        path: 'self.navigation.racing.bestVmg.toCourseSide',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        // Fixed, like its three siblings below: vmgUnit() formats all four from this one
        // key, so a path that followed the server's speed preference on its own would
        // label the other three wrongly.
        convertUnitTo: 'knots', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        enableTimeout: false
      },
      vmgToPortEndPath: {
        description: 'Best VMG along the line towards the port end (pin)',
        path: 'self.navigation.racing.bestVmg.toPortEnd',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'knots', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        enableTimeout: false
      },
      vmgToStbEndPath: {
        description: 'Best VMG along the line towards the starboard end (boat)',
        path: 'self.navigation.racing.bestVmg.toStbEnd',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'knots', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        enableTimeout: false
      },
      vmgFromCourseSidePath: {
        description: 'Best VMG back across the line from the course side',
        path: 'self.navigation.racing.bestVmg.fromCourseSide',
        source: 'default', pathType: 'number', pathRequired: false, isPathConfigurable: false,
        convertUnitTo: 'knots', showConvertUnitTo: false, showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        enableTimeout: false
      }
    }
  };

  // Everything live, handed to the drawing as one object so it recomputes its scene once
  // per update rather than once per path.
  private readonly view = signal<IRacerLineViewData>({
    portLat: null, portLon: null, stbLat: null, stbLon: null,
    lat: null, lon: null, fixTime: null,
    heading: null, cog: null, sog: null,
    lineLength: null, lineBearing: null,
    timeToStart: null, timerRunning: false, twd: null,
    boatLength: null, effVmgToLine: null, effVmgAlongLine: null,
    bestVmg: { ...NO_VMG }
  });
  protected readonly viewData = this.view.asReadonly();

  protected readonly palette = signal<{ color: string; dim: string; dimmer: string }>(
    { color: 'var(--skip-contrast-color)', dim: 'var(--skip-contrast-dim-color)',
      dimmer: 'var(--skip-contrast-dimmer-color)' });

  private cfg(): IWidgetSvcConfig {
    return this.runtime.options() ?? WidgetRacerLineViewComponent.DEFAULT_CONFIG;
  }

  private get pathsRecord(): Record<string, IWidgetPath> {
    return (this.cfg().paths as Record<string, IWidgetPath> | undefined) ?? {};
  }

  protected readonly title = computed<string>(() => this.cfg().displayName || 'Start Line');
  protected readonly viewSmoothing = computed<number>(() => this.cfg().viewSmoothing ?? 10);
  protected readonly viewFreezeSeconds = computed<number>(() => this.cfg().viewFreezeSeconds ?? 15);
  /**
   * The unit every distance in the drawing is shown in: the line's length, the approach
   * legs, all of it.
   *
   * Taken from the unit the length stream actually resolved to rather than from the
   * stored config, because a path that follows the server's unit preference is converted
   * to whatever that preference says - which is not necessarily what `convertUnitTo`
   * holds. Reading the config instead is how the legs came to be drawn in metres beside a
   * line length in nautical miles. Falls back to the stored unit until the first value
   * arrives.
   */
  private readonly lengthMeasure = signal<string | null>(null);
  protected readonly lengthUnit = computed<string>(() =>
    this.lengthMeasure() ?? this.pathsRecord['lineLengthPath']?.convertUnitTo ?? 'm');
  protected readonly vmgUnit = computed<string>(() =>
    this.pathsRecord['vmgToCourseSidePath']?.convertUnitTo ?? 'knots');

  /**
   * Editing the line rather than watching it.
   *
   * Entered and left by the one button, and never by a timeout: pinging the ends takes
   * as long as it takes, and a mode that expired just as the helm reached for the pin
   * would be worse than no mode at all.
   */
  protected readonly editMode = signal<boolean>(false);

  /** The named lines the plugin knows, and which is current. */
  private readonly lines = signal<string[]>(['Default']);
  private readonly startLineName = signal<string | null>(null);
  protected readonly lineNames = computed<string[]>(() => this.lines());
  protected readonly currentLineName = computed<string>(() => this.startLineName() || 'Default');

  protected toggleEdit(): void {
    this.editMode.update(v => !v);
  }

  /** Put an end of the line on the boat's current position. */
  protected setLineEnd(end: 'port' | 'stb'): void {
    this.signalk.putRequest('navigation.racing.setStartLine', { end, position: 'bow' }, this.id());
  }

  protected selectLine(name: string): void {
    this.signalk.putRequest('navigation.racing.setStartLineName',
      { startLineName: name === 'Default' ? null : name }, this.id());
  }

  constructor() {
    effect(() => {
      const cfg = this.runtime.options() ?? WidgetRacerLineViewComponent.DEFAULT_CONFIG;
      const theme = this.theme();
      if (!theme) return;
      untracked(() => this.palette.set(getColors(cfg.color ?? 'contrast', theme)));
    });

    const num = (key: string, apply: (v: number | null, at: number | null) => void) => {
      effect(() => {
        if (!this.pathsRecord[key]?.path) return;
        untracked(() => this.streams.observe(key, pkt => {
          const value = pkt?.data?.value;
          const at = pkt?.data?.timestamp;
          apply(typeof value === 'number' ? value : null, at ? at.getTime() : null);
        }));
      });
    };

    /** The same, for a path whose value is a whole {latitude, longitude} in degrees. */
    const position = (key: string,
      apply: (pos: { latitude?: number | null; longitude?: number | null } | null,
        at: number | null) => void) => {
      effect(() => {
        if (!this.pathsRecord[key]?.path) return;
        untracked(() => this.streams.observe(key, pkt => {
          const value = pkt?.data?.value as
            { latitude?: number | null; longitude?: number | null } | null | undefined;
          const at = pkt?.data?.timestamp;
          apply(value ?? null, at ? at.getTime() : null);
        }));
      });
    };
    // Signal K emits a position whole, at its own path: the delta service stopped
    // fabricating dotted child paths for object values (SK-02 / #21), so there is no
    // navigation.position.latitude to subscribe to. All three positions here - the two
    // line ends and the vessel - arrive as one {latitude, longitude} object in degrees.
    position('portPath', (pos) =>
      this.view.update(d => ({ ...d, portLat: pos?.latitude ?? null, portLon: pos?.longitude ?? null })));
    position('stbPath', (pos) =>
      this.view.update(d => ({ ...d, stbLat: pos?.latitude ?? null, stbLon: pos?.longitude ?? null })));
    position('positionPath', (pos, at) =>
      this.view.update(d => ({ ...d, lat: pos?.latitude ?? null, lon: pos?.longitude ?? null, fixTime: at })));
    num('headingPath', v => this.view.update(d => ({ ...d, heading: v })));
    num('cogPath', v => this.view.update(d => ({ ...d, cog: v })));
    num('twdPath', v => this.view.update(d => ({ ...d, twd: v })));
    num('sogPath', v => this.view.update(d => ({ ...d, sog: v })));
    // Bespoke rather than num(), to keep the resolved measure as well as the value.
    effect(() => {
      if (!this.pathsRecord['lineLengthPath']?.path) return;
      untracked(() => this.streams.observe('lineLengthPath', pkt => {
        const value = pkt?.data?.value;
        this.lengthMeasure.set(pkt?.data?.measure ?? null);
        this.view.update(d => ({ ...d, lineLength: typeof value === 'number' ? value : null }));
      }));
    });
    num('lineBearingPath', v => this.view.update(d => ({ ...d, lineBearing: v })));
    num('ttsPath', v => this.view.update(d => ({ ...d, timeToStart: v })));
    num('boatLengthPath', v => this.view.update(d => ({ ...d, boatLength: v })));
    num('effectiveVmgToLinePath', v => this.view.update(d => ({ ...d, effVmgToLine: v })));
    num('effectiveVmgAlongLinePath', v => this.view.update(d => ({ ...d, effVmgAlongLine: v })));
    // The collected bests still matter: they are the fallback the drawing derives its
    // effective VMGs from when the plugin does not publish them.
    for (const name of VMG_NAMES) {
      const cap = name.charAt(0).toUpperCase() + name.slice(1);
      num(`vmg${cap}Path`, v =>
        this.view.update(d => ({ ...d, bestVmg: { ...d.bestVmg, [name]: v } })));
    }

    effect(() => {
      if (!this.pathsRecord['startLineNamePath']?.path) return;
      untracked(() => this.streams.observe('startLineNamePath', pkt =>
        this.startLineName.set((pkt?.data?.value as string) ?? null), 'startLineName'));
    });

    effect(() => {
      if (!this.pathsRecord['linesPath']?.path) return;
      untracked(() => this.streams.observe('linesPath', pkt => {
        const named = ['Default'];
        const value = pkt?.data?.value;
        if (Array.isArray(value)) {
          for (const line of value) {
            if (line?.startLineName) named.push(line.startLineName as string);
          }
        }
        this.lines.set(named);
      }, 'lines'));
    });

    effect(() => {
      if (!this.pathsRecord['startTimePath']?.path) return;
      untracked(() => this.streams.observe('startTimePath', pkt =>
        this.view.update(d => ({ ...d, timerRunning: !!pkt?.data?.value }))));
    });
  }
}
