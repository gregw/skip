import { Component, OnDestroy, inject, ChangeDetectionStrategy, input, effect, untracked, signal, computed, WritableSignal } from '@angular/core';
import { Subscription, interval } from 'rxjs';
import { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';
import { POLAR_OVERLAY_DIAL_RADIUS, POLAR_OVERLAY_PEAK_RADIUS, PolarOverlayMode, SvgWindsteerComponent } from '../svg-windsteer/svg-windsteer.component';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { WidgetStreamsDirective } from '../../core/directives/widget-streams.directive';
import { IPathUpdate } from '../../core/services/data.service';
import { ITheme } from '../../core/services/app-service';
import { UnitsService } from '../../core/services/units.service';
import { ActivePolarService } from '../../core/services/active-polar.service';
import { OverlayPoint, OverlayScale, POLAR_OVERLAY_PATH_KEYS, normalizeRadians, polarCurve, polarSpeedProfile, speedToRadius, vmcCurve, vmcDotRadius } from '../../core/utils/polar-overlay.util';

// Default rolling window (seconds) for the wind-sector history; the single
// source of truth for both the default config and the missing-value fallback.
const DEFAULT_WIND_SECTOR_WINDOW_SECONDS = 5;

// Default stale-data TTL (seconds): an indicator hides this long after its last valid sample.
// Single source of truth for the default config and the missing/invalid-value fallback.
const DEFAULT_DATA_TIMEOUT_SECONDS = 5;

// Overlay auto-hide thresholds in SI (m/s). Compared against the true speed regardless of the
// path's display unit. The current-set arrow shows from SHOW and hides only below HIDE, so a drift
// estimate hovering near one limit cannot blink it; the COG arrow hides below SOG.
const SET_ARROW_SHOW_MS = 0.1;
const SET_ARROW_HIDE_MS = 0.05;
const SOG_HIDE_LIMIT_MS = 0.05;
// Change-detection dedup granularity in SI (m/s): a speed signal only re-sets when it moves at least
// this much, converted to the value's own display unit each update — never a fixed display-unit step.
const SPEED_DEDUP_MS = 0.05;
const DEG_TO_RAD = Math.PI / 180;
// Angle dedup granularity for the SI overlay inputs: 1° expressed in radians.
const ANGLE_DEDUP_RAD = DEG_TO_RAD;

@Component({
  selector: 'widget-wind-steer',
  templateUrl: './widget-windsteer.component.html',
  imports: [SvgWindsteerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class WidgetWindComponent implements OnDestroy {
  public id = input.required<string>();
  public type = input.required<string>();
  public theme = input.required<ITheme|null>();

  public static readonly DEFAULT_CONFIG: IWidgetSvcConfig = {
    supportAutomaticHistoricalSeries: false,
    filterSelfPaths: true,
    paths: {
      headingPath: {
        description: 'Heading',
        pathOptions: [
          { label: 'True', path: 'self.navigation.headingTrue' },
          { label: 'Magnetic', path: 'self.navigation.headingMagnetic' }
        ],
        path: 'self.navigation.headingTrue',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: true,
        pathRequired: true,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        convertUnitTo: 'deg',
        showConvertUnitTo: false
      },
      appWindAngle: {
        description: 'Apparent Wind Angle',
        path: 'self.environment.wind.angleApparent',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: false,
        pathRequired: true,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        convertUnitTo: 'deg',
        showConvertUnitTo: false
      },
      appWindSpeed: {
        description: 'Apparent Wind Speed',
        path: 'self.environment.wind.speedApparent',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: false,
        pathRequired: true,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        convertUnitTo: 'knots'
      },
      trueWindAngle: {
        description: 'Wind Angle',
        pathOptions: [
          { label: 'Water', path: 'self.environment.wind.angleTrueWater' },
          { label: 'Ground', path: 'self.environment.wind.angleTrueGround' }
        ],
        path: 'self.environment.wind.angleTrueWater',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: true,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        convertUnitTo: 'deg',
        showConvertUnitTo: false
      },
      trueWindSpeed: {
        description: 'True Wind Speed',
        path: 'self.environment.wind.speedTrue',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: false,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        convertUnitTo: 'knots'
      },
      courseOverGround: {
        description: 'Course Over Ground',
        pathOptions: [
          { label: 'True', path: 'self.navigation.courseOverGroundTrue' },
          { label: 'Magnetic', path: 'self.navigation.courseOverGroundMagnetic' }
        ],
        path: 'self.navigation.courseOverGroundTrue',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: true,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        showConvertUnitTo: false,
        convertUnitTo: 'deg'
      },
      speedOverGround: {
        description: 'Speed Over Ground',
        path: 'self.navigation.speedOverGround',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: false,
        hideFromConfig: true,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        convertUnitTo: 'knots'
      },
      nextWaypointBearing: {
        description: 'Next Waypoint True Bearing',
        path: 'self.navigation.course.calcValues.bearingTrue',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: false,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        convertUnitTo: 'deg',
        showConvertUnitTo: false
      },
      set: {
        description: 'True Drift Set',
        path: 'self.environment.current.setTrue',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: false,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        convertUnitTo: 'deg',
        showConvertUnitTo: false
      },
      drift: {
        description: 'Drift Speed Impact',
        path: 'self.environment.current.drift',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: false,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        convertUnitTo: 'knots'
      },
      polarTrueWindSpeed: {
        description: 'Polar Overlay True Wind Speed',
        path: 'self.environment.wind.speedTrue',
        source: 'default',
        sourceFromPath: 'trueWindSpeed',
        pathType: 'number',
        isPathConfigurable: false,
        hideFromConfig: true,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        convertUnitTo: 'm/s',
        showConvertUnitTo: false
      },
      polarTrueWindAngle: {
        description: 'Polar Overlay True Wind Angle (water)',
        path: 'self.environment.wind.angleTrueWater',
        source: 'default',
        sourceFromPath: 'trueWindAngle',
        pathType: 'number',
        isPathConfigurable: false,
        hideFromConfig: true,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        convertUnitTo: 'rad',
        showConvertUnitTo: false
      },
      polarSpeedThroughWater: {
        description: 'Polar Overlay Speed Through Water',
        path: 'self.navigation.speedThroughWater',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: false,
        hideFromConfig: true,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'm/s',
        convertUnitTo: 'm/s',
        showConvertUnitTo: false
      },
      rudderAngle: {
        description: 'Rudder Angle',
        path: 'self.steering.rudderAngle',
        source: 'default',
        pathType: 'number',
        isPathConfigurable: true,
        pathRequired: false,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: 'rad',
        convertUnitTo: 'deg',
        showConvertUnitTo: false
      }
    },
    compassModeEnabled: true,
    windSectorEnable: true,
    windSectorWindowSeconds: DEFAULT_WIND_SECTOR_WINDOW_SECONDS,
    laylineEnable: true,
    laylineAngle: 45,
    waypointEnable: true,
    courseOverGroundEnable: true,
    driftEnable: true,
    awsEnable: true,
    twsEnable: true,
    twaEnable: true,
    sailSetupEnable: false,
    rudderEnable: true,
    invertRudder: false,
    polarOverlayEnable: false,
    updateInterval: 1000,
    enableTimeout: false,
    dataTimeout: DEFAULT_DATA_TIMEOUT_SECONDS
  };

  public readonly runtime = inject(WidgetRuntimeDirective); // accessed in template
  private readonly stream = inject(WidgetStreamsDirective);
  private readonly unitsService = inject(UnitsService);
  private readonly activePolar = inject(ActivePolarService);

  private hasHeading = false;
  private hasCOG = false;
  private hasAWA = false;
  private hasAWS = false;
  private hasTWA = false;
  private hasTWS = false;
  private hasSet = false;
  private hasDrift = false;
  private hasWPT = false;
  private hasSOG = false;
  private lastRawTrueWindAngle: number | null = null;
  private lastRawRudder: number | null = null;

  protected currentHeading = signal(0);
  protected courseOverGroundAngle = signal(0);
  protected appWindAngle = signal(0);
  protected appWindSpeed = signal(0);
  private appWindSpeedMeasure = signal('');
  protected appWindSpeedUnit = computed(() => this.speedUnitSymbol(this.appWindSpeedMeasure()));
  protected trueWindAngle = signal(0);
  protected trueWindFresh = signal(false);
  protected trueWindSpeed = signal(0);
  private trueWindSpeedMeasure = signal('');
  protected trueWindSpeedUnit = computed(() => this.speedUnitSymbol(this.trueWindSpeedMeasure()));
  protected driftFlow = signal(0);
  private driftMeasure = signal('');
  protected driftUnit = computed(() => this.speedUnitSymbol(this.driftMeasure()));
  // Evaluated on every raw sample, not the deduped driftFlow: the dedup step equals the band width.
  protected setArrowActive = signal(false);
  protected driftSet = signal(0);
  protected sog = signal<number | undefined>(undefined);
  private sogMeasure = signal('');
  // SOG absent (boat publishes COG but not speed) is treated as "moving" so the COG arrow still
  // shows; only a present, sub-threshold SOG hides it.
  protected sogActive = computed(() => {
    const s = this.sog();
    return s == null || s >= this.speedInDisplayUnit(this.sogMeasure(), SOG_HIDE_LIMIT_MS);
  });
  protected waypointAngle = signal<number | undefined>(undefined);
  // Per-path data freshness: true while a valid sample arrived within the TTL, false after it
  // lapses. The value signals hold their last value (freeze); these gate whether the indicator
  // is shown, so absent/invalid data hides rather than rendering as 0. trueWindFresh (above)
  // is the true-wind-angle member of this set.
  protected headingFresh = signal(false);
  protected courseFresh = signal(false);
  protected appWindFresh = signal(false);
  protected appWindSpeedFresh = signal(false);
  protected trueWindSpeedFresh = signal(false);
  // Current/drift has two independent paths: drift = speed (readout), set = direction (arrow).
  // Each tracks its own freshness so a stalled half hides rather than showing a frozen value.
  protected driftFresh = signal(false);
  protected setFresh = signal(false);
  // Signed degrees, +ve = starboard (after invertRudder). null = no rudder data (bar hidden).
  protected rudderAngle = signal<number | null>(null);
  // The bearing's own freshness gates only the overlay mode; the waypoint marker keeps its own rule.
  private waypointFresh = signal(false);

  // Polar overlay inputs, in SI from the hidden structural slots, never from the display paths.
  private overlayRegistered = false;
  private hasOverlayTws = false;
  private hasOverlayTwa = false;
  private hasOverlayStw = false;
  private overlayTws = signal(0);          // m/s
  private overlayTwsFresh = signal(false);
  private overlayTwa = signal(0);          // rad, water-referenced, signed
  private overlayTwaFresh = signal(false);
  private overlayStw = signal(0);          // m/s
  private overlayStwFresh = signal(false);

  protected overlayMode = computed<PolarOverlayMode>(() => {
    const cfg = this.runtime.options();
    const bearing = this.waypointAngle();
    return resolvePolarOverlayMode({
      enabled: !!cfg?.polarOverlayEnable,
      polarReady: this.activePolar.status().kind === 'ready',
      twsFresh: this.overlayTwsFresh(),
      twaFresh: this.overlayTwaFresh(),
      compassMode: !!cfg?.compassModeEnabled,
      headingFresh: this.headingFresh(),
      waypointActive: !!cfg?.waypointEnable && bearing != null && Number.isFinite(bearing) && this.waypointFresh()
    });
  });
  private overlayScale = computed<OverlayScale | null>(() => {
    const peakSpeed = this.activePolar.peakSpeed();
    return peakSpeed ? { peakSpeed, peakRadius: POLAR_OVERLAY_PEAK_RADIUS, dialRadius: POLAR_OVERLAY_DIAL_RADIUS } : null;
  });
  /** Wind-frame polar curve; its shape depends only on TWS, the performance factor and the polar. */
  protected polarCurvePoints = computed<OverlayPoint[] | null>(() => {
    if (this.overlayMode() !== 'polar') return null;
    const polar = this.activePolar.polar();
    const scale = this.overlayScale();
    if (!polar || !scale) return null;
    return polarCurve(polar, this.overlayTws(), this.activePolar.performanceFactor(), scale);
  });
  /** Polar speeds per TWA for the present TWS, reused by every VMC recompute until TWS changes. */
  private vmcSpeedProfile = computed(() => {
    if (this.overlayMode() !== 'vmc') return null;
    const polar = this.activePolar.polar();
    return polar ? polarSpeedProfile(polar, this.overlayTws(), this.activePolar.performanceFactor()) : null;
  });
  /** Water TWD = HDG + water TWA, rad; changes under 1° do not propagate. */
  private overlayTwd = computed(
    () => normalizeRadians(this.currentHeading() * DEG_TO_RAD + this.overlayTwa()),
    { equal: (a, b) => radianDelta(a, b) < ANGLE_DEDUP_RAD }
  );
  /** Compass-frame VMC curve toward the waypoint. */
  protected vmcCurvePoints = computed<OverlayPoint[] | null>(() => {
    const profile = this.vmcSpeedProfile();
    const scale = this.overlayScale();
    const bearing = this.waypointAngle();
    if (!profile || !scale || bearing == null) return null;
    return vmcCurve(profile, this.overlayTwd(), bearing * DEG_TO_RAD, scale);
  });
  /** Rotation of the polar curve group: the water TWA the curve is anchored to, degrees. */
  protected overlayTwaDeg = computed(() => this.overlayTwa() / DEG_TO_RAD);
  /** Radius of the dot on the bow axis; null hides it. */
  protected overlayDotRadius = computed<number | null>(() => {
    const mode = this.overlayMode();
    const scale = this.overlayScale();
    if (mode === 'hidden' || !scale || !this.overlayStwFresh()) return null;
    const stw = this.overlayStw();
    if (mode === 'polar') return speedToRadius(stw, scale);
    const bearing = this.waypointAngle();
    return bearing == null ? null : vmcDotRadius(stw, this.currentHeading() * DEG_TO_RAD, bearing * DEG_TO_RAD, scale);
  });

  protected historicalWindDirection: { timestamp: number; windDirection: number; }[] = [];
  protected trueWindMinHistoric = signal<number | undefined>(undefined);
  protected trueWindMidHistoric = signal<number | undefined>(undefined);
  protected trueWindMaxHistoric = signal<number | undefined>(undefined);

  private windSectorObservableSub: Subscription | null = null;

  private windSamples: { t: number; u: number; i: number }[] = [];
  private windMinDeque: { i: number; u: number }[] = [];
  private windMaxDeque: { i: number; u: number }[] = [];
  private windSampleIndex = 0;
  private lastUnwrapped: number | null = null;
  private lastSector: { min?: number; mid?: number; max?: number } = {};

  private readonly DEG_EPSILON = 1;      // degrees — angle paths are structurally fixed to degrees

  // On each valid sample a path's active flag is set true and its hide-timer re-armed; when the
  // timer fires (no valid sample within the TTL) the flag goes false and the indicator hides.
  // Independent of the streams-directive enableTimeout, so it works whether that is on or off.
  private readonly freshnessTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dataTtlMs(): number {
    const cfg = this.runtime.options();
    const configured = cfg?.dataTimeout;
    const base = (typeof configured === 'number' && configured > 0 ? configured : DEFAULT_DATA_TIMEOUT_SECONDS) * 1000;
    // Never shorter than twice the sample cadence, so a healthy but slow-updating stream cannot
    // lapse between samples and flicker the indicator.
    const cadence = typeof cfg?.updateInterval === 'number' && cfg.updateInterval > 0 ? cfg.updateInterval : 0;
    return Math.max(base, cadence * 2);
  }
  private markFresh(key: string, active: WritableSignal<boolean>): void {
    active.set(true);
    const existing = this.freshnessTimers.get(key);
    if (existing) clearTimeout(existing);
    this.freshnessTimers.set(key, setTimeout(() => active.set(false), this.dataTtlMs()));
  }

  constructor() {
    // Stable stream callbacks registered via effect; directive handles diffing
    effect(() => {
      const cfg = this.runtime.options();
      if (!cfg) return;
      untracked(() => {
        if (cfg.polarOverlayEnable) this.activePolar.ensureStarted();
        this.registerStreams();
        this.stopWindSectors();
        this.startWindSectors();
        // A live compass-mode or TWA-path change does not re-fire the wind stream, so recompute
        // the displayed base from the cached sample here; otherwise the dial keeps a stale heading
        // offset until the next sample arrives (#73). currentHeading is read untracked to avoid
        // re-running this effect on every heading tick.
        this.applyTrueWindBase();
        // A live invertRudder toggle must re-sign the cached sample without a new stream tick.
        this.applyRudder();
      });
    });
  }

  // Stable callbacks -------------------------------------------------
  private onHeadingUpdate = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;   // freeze on absent/invalid
    const next = this.normalizeAngle(raw);
    this.markFresh('heading', this.headingFresh);
    if (!this.hasHeading || this.angleDelta(this.currentHeading(), next) >= this.DEG_EPSILON) {
      this.currentHeading.set(next); this.hasHeading = true;
    }
  };
  private onCOGUpdate = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;
    const next = this.normalizeAngle(raw);
    this.markFresh('cog', this.courseFresh);
    if (!this.hasCOG || this.angleDelta(this.courseOverGroundAngle(), next) >= this.DEG_EPSILON) {
      this.courseOverGroundAngle.set(next); this.hasCOG = true;
    }
  };
  private onDriftUpdate = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;
    this.markFresh('drift', this.driftFresh);
    const measure = u.data.measure ?? '';
    const limit = this.setArrowActive() ? SET_ARROW_HIDE_MS : SET_ARROW_SHOW_MS;
    this.setArrowActive.set(raw >= this.speedInDisplayUnit(measure, limit));
    if (!this.hasDrift || Math.abs(this.driftFlow() - raw) >= this.speedInDisplayUnit(measure, SPEED_DEDUP_MS)) {
      this.driftFlow.set(raw); this.hasDrift = true;
      this.driftMeasure.set(measure);
    }
  };
  private onSOGUpdate = (u: IPathUpdate) => {
    // Absence is distinct from zero: a boat may publish COG without SOG, and its COG arrow must
    // still show underway. Propagate undefined for no data so only a real near-zero SOG hides it.
    if (u.data.value == null) {
      this.sog.set(undefined); this.hasSOG = true;
      return;
    }
    const next = u.data.value;
    const cur = this.sog();
    if (!this.hasSOG || cur == null || Math.abs(cur - next) >= this.speedInDisplayUnit(u.data.measure ?? '', SPEED_DEDUP_MS)) {
      this.sog.set(next); this.hasSOG = true;
      this.sogMeasure.set(u.data.measure ?? '');
    }
  };
  private onSetUpdate = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;
    const next = this.normalizeAngle(raw);
    this.markFresh('set', this.setFresh);
    if (!this.hasSet || this.angleDelta(this.driftSet(), next) >= this.DEG_EPSILON) {
      this.driftSet.set(next); this.hasSet = true;
    }
  };
  private onWaypointUpdate = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null) {
      this.waypointAngle.set(undefined); this.hasWPT = true;
      return;
    }
    const next = this.normalizeAngle(raw);
    if (Number.isFinite(next)) this.markFresh('wpt', this.waypointFresh);
    const cur = this.waypointAngle();
    if (!this.hasWPT || cur == null || this.angleDelta(cur, next) >= this.DEG_EPSILON) {
      this.waypointAngle.set(next); this.hasWPT = true;
    }
  };
  private onOverlayTws = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;
    this.markFresh('polarTrueWindSpeed', this.overlayTwsFresh);
    if (!this.hasOverlayTws || Math.abs(this.overlayTws() - raw) >= SPEED_DEDUP_MS) {
      this.overlayTws.set(raw); this.hasOverlayTws = true;
    }
  };
  private onOverlayTwa = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;
    this.markFresh('polarTrueWindAngle', this.overlayTwaFresh);
    if (!this.hasOverlayTwa || radianDelta(this.overlayTwa(), raw) >= ANGLE_DEDUP_RAD) {
      this.overlayTwa.set(raw); this.hasOverlayTwa = true;
    }
  };
  private onOverlayStw = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;
    this.markFresh('polarSpeedThroughWater', this.overlayStwFresh);
    if (!this.hasOverlayStw || Math.abs(this.overlayStw() - raw) >= SPEED_DEDUP_MS) {
      this.overlayStw.set(raw); this.hasOverlayStw = true;
    }
  };
  /** Each overlay slot's handler and freshness signal; the slot key is also its freshness-timer key. */
  private readonly overlayInputs: Record<(typeof POLAR_OVERLAY_PATH_KEYS)[number], { onUpdate: (u: IPathUpdate) => void; fresh: WritableSignal<boolean> }> = {
    polarTrueWindSpeed: { onUpdate: this.onOverlayTws, fresh: this.overlayTwsFresh },
    polarTrueWindAngle: { onUpdate: this.onOverlayTwa, fresh: this.overlayTwaFresh },
    polarSpeedThroughWater: { onUpdate: this.onOverlayStw, fresh: this.overlayStwFresh }
  };
  private onRudderUpdate = (u: IPathUpdate) => {
    // A non-finite or absent value hides the bar; a real 0 keeps it present but draws nothing.
    // Cache the raw value so a live invertRudder toggle can re-sign it without a new sample.
    this.lastRawRudder = Number.isFinite(u.data.value) ? u.data.value : null;
    this.applyRudder();
  };
  private onAppWindAngle = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;
    const next = this.normalizeAngle(raw);
    this.markFresh('awa', this.appWindFresh);
    if (!this.hasAWA || this.angleDelta(this.appWindAngle(), next) >= this.DEG_EPSILON) {
      this.appWindAngle.set(next); this.hasAWA = true;
    }
  };
  private onAppWindSpeed = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;
    this.markFresh('aws', this.appWindSpeedFresh);
    if (!this.hasAWS || Math.abs(this.appWindSpeed() - raw) >= this.speedInDisplayUnit(u.data.measure ?? '', SPEED_DEDUP_MS)) {
      this.appWindSpeed.set(raw); this.hasAWS = true;
      this.appWindSpeedMeasure.set(u.data.measure ?? '');
    }
  };
  private onTrueWindSpeed = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;
    this.markFresh('tws', this.trueWindSpeedFresh);
    if (!this.hasTWS || Math.abs(this.trueWindSpeed() - raw) >= this.speedInDisplayUnit(u.data.measure ?? '', SPEED_DEDUP_MS)) {
      this.trueWindSpeed.set(raw); this.hasTWS = true;
      this.trueWindSpeedMeasure.set(u.data.measure ?? '');
    }
  };
  private onTrueWindAngle = (u: IPathUpdate) => {
    const raw = u.data.value;
    if (raw == null || !Number.isFinite(raw)) return;   // freeze; the TTL timer hides after lapse
    this.lastRawTrueWindAngle = raw;
    this.markFresh('twa', this.trueWindFresh);
    const next = this.normalizeAngle(this.computeTrueWindBase(raw));
    if (!this.hasTWA || this.angleDelta(this.trueWindAngle(), next) >= this.DEG_EPSILON) {
      this.trueWindAngle.set(next); this.hasTWA = true;
    }
    if (this.runtime.options()?.windSectorEnable) {
      this.addHistoricalWindDirection(this.normalizeAngle(this.computeTrueWindDirection(raw)));
    }
  };

  private trueWindPath(): string {
    return this.runtime.options()?.paths?.['trueWindAngle']?.path || '';
  }

  private computeTrueWindBase(rawAngle: number): number {
    const compassMode = !!this.runtime.options()?.compassModeEnabled;
    return computeTrueWindBaseAngle(this.trueWindPath(), rawAngle, this.currentHeading(), compassMode);
  }

  // Wind sectors track the true wind DIRECTION (compass frame) so heading and boat-speed
  // changes don't smear the oscillation range; only real wind shifts move it.
  private computeTrueWindDirection(rawAngle: number): number {
    return computeTrueWindBaseAngle(this.trueWindPath(), rawAngle, this.currentHeading(), true);
  }

  private applyTrueWindBase() {
    if (this.lastRawTrueWindAngle == null) return;
    this.trueWindAngle.set(this.normalizeAngle(this.computeTrueWindBase(this.lastRawTrueWindAngle)));
  }

  // Resolve the signed rudder angle from the last raw sample. steering.rudderAngle is +ve to
  // starboard, and a rudder to starboard turns the boat to starboard, so the raw sign already
  // matches the side the boat turns (green to the right); invertRudder corrects a reversed sensor.
  private applyRudder() {
    const raw = this.lastRawRudder;
    if (raw == null) {
      if (this.rudderAngle() !== null) this.rudderAngle.set(null);
      return;
    }
    const signed = (this.runtime.options()?.invertRudder ?? false) ? -raw : raw;
    const cur = this.rudderAngle();
    if (cur == null || Math.abs(cur - signed) >= this.DEG_EPSILON) {
      this.rudderAngle.set(signed);
    }
  }

  private registerStreams() {
    const cfg = this.runtime.options();
    if (!cfg) return;
    this.stream.observe('headingPath', this.onHeadingUpdate);
    this.stream.observe('courseOverGround', this.onCOGUpdate);
    this.stream.observe('speedOverGround', this.onSOGUpdate);
    this.stream.observe('drift', this.onDriftUpdate);
    this.stream.observe('set', this.onSetUpdate);
    this.stream.observe('nextWaypointBearing', this.onWaypointUpdate);
    this.stream.observe('appWindAngle', this.onAppWindAngle);
    this.stream.observe('appWindSpeed', this.onAppWindSpeed);
    this.stream.observe('trueWindSpeed', this.onTrueWindSpeed);
    this.stream.observe('trueWindAngle', this.onTrueWindAngle);
    this.stream.observe('rudderAngle', this.onRudderUpdate);
    this.registerOverlayStreams(!!cfg.polarOverlayEnable);
  }

  // The overlay's SI slots are subscribed only while the option is on.
  private registerOverlayStreams(enabled: boolean) {
    if (enabled) {
      for (const key of POLAR_OVERLAY_PATH_KEYS) this.stream.observe(key, this.overlayInputs[key].onUpdate);
      this.overlayRegistered = true;
      return;
    }
    if (!this.overlayRegistered) return;
    this.overlayRegistered = false;
    // A later re-enable must wait for fresh samples rather than draw from the old ones.
    this.hasOverlayTws = this.hasOverlayTwa = this.hasOverlayStw = false;
    for (const key of POLAR_OVERLAY_PATH_KEYS) {
      this.stream.unobserve(key);
      clearTimeout(this.freshnessTimers.get(key));
      this.freshnessTimers.delete(key);
      this.overlayInputs[key].fresh.set(false);
    }
  }

  ngOnDestroy() {
    this.stopWindSectors();
    this.freshnessTimers.forEach(clearTimeout);
    this.freshnessTimers.clear();
  }

  private startWindSectors() {
    this.windSamples = [];
    this.windMinDeque = [];
    this.windMaxDeque = [];
    this.windSampleIndex = 0;
    this.lastUnwrapped = null;
    this.lastSector = {};

    if (!this.runtime.options()?.windSectorEnable) {
      this.trueWindMinHistoric.set(undefined);
      this.trueWindMidHistoric.set(undefined);
      this.trueWindMaxHistoric.set(undefined);
      this.lastSector = {};
      return;
    }

    this.windSectorObservableSub = interval(1000).subscribe(() => {
      this.historicalCleanup();
    });
  }

  private addHistoricalWindDirection(absAngle: number) {
    const now = Date.now();
    const u = this.unwrapAngle(absAngle);
    const i = this.windSampleIndex++;
    this.windSamples.push({ t: now, u, i });
    while (this.windMinDeque.length && this.windMinDeque[this.windMinDeque.length - 1].u >= u) {
      this.windMinDeque.pop();
    }
    this.windMinDeque.push({ i, u });
    while (this.windMaxDeque.length && this.windMaxDeque[this.windMaxDeque.length - 1].u <= u) {
      this.windMaxDeque.pop();
    }
    this.windMaxDeque.push({ i, u });
  }

  private historicalCleanup() {
    if (!this.runtime.options()?.windSectorEnable) return;
    const cutoff = Date.now() - (this.runtime.options()?.windSectorWindowSeconds ?? DEFAULT_WIND_SECTOR_WINDOW_SECONDS) * 1000;
    while (this.windSamples.length && this.windSamples[0].t < cutoff) {
      const removed = this.windSamples.shift();
      if (!removed) break;
      if (this.windMinDeque.length && this.windMinDeque[0].i === removed.i) this.windMinDeque.shift();
      if (this.windMaxDeque.length && this.windMaxDeque[0].i === removed.i) this.windMaxDeque.shift();
    }

    if (!this.windSamples.length || !this.windMinDeque.length || !this.windMaxDeque.length) {
      if (this.trueWindMinHistoric() !== undefined || this.trueWindMidHistoric() !== undefined || this.trueWindMaxHistoric() !== undefined) {
        this.trueWindMinHistoric.set(undefined);
        this.trueWindMidHistoric.set(undefined);
        this.trueWindMaxHistoric.set(undefined);
        this.lastSector = {};
      }
      return;
    }

    const minU = this.windMinDeque[0].u;
    const maxU = this.windMaxDeque[0].u;
    const midU = (minU + maxU) / 2;
    const nextMin = this.normalizeAngle(minU);
    const nextMid = this.normalizeAngle(midU);
    const nextMax = this.normalizeAngle(maxU);
    const changed =
      this.lastSector.min === undefined || this.angleDelta(this.lastSector.min!, nextMin) >= this.DEG_EPSILON ||
      this.lastSector.mid === undefined || this.angleDelta(this.lastSector.mid!, nextMid) >= this.DEG_EPSILON ||
      this.lastSector.max === undefined || this.angleDelta(this.lastSector.max!, nextMax) >= this.DEG_EPSILON;
    if (changed) {
      this.trueWindMinHistoric.set(nextMin);
      this.trueWindMidHistoric.set(nextMid);
      this.trueWindMaxHistoric.set(nextMax);
      this.lastSector = { min: nextMin, mid: nextMid, max: nextMax };
    }
  }

  private stopWindSectors() {
    this.windSectorObservableSub?.unsubscribe();
  }

  private unwrapAngle(a: number): number {
    if (this.lastUnwrapped == null) {
      this.lastUnwrapped = a;
      return a;
    }
    const last = this.lastUnwrapped;
    const lastMod = ((last % 360) + 360) % 360;
    const diff = ((a - lastMod + 540) % 360) - 180;
    const u = last + diff;
    this.lastUnwrapped = u;
    return u;
  }

  private normalizeAngle(a: number): number { return ((a % 360) + 360) % 360; }
  private angleDelta(from: number, to: number): number { const d = ((to - from + 540) % 360) - 180; return Math.abs(d); }

  // The speed readouts derive their unit symbol from the measure the streams directive tagged the
  // value with (server-resolved for these display paths), never the stored convertUnitTo. An empty
  // or still-unitless measure (meta not yet resolved) renders no symbol rather than a wrong one, so
  // the label always matches the value.
  private speedUnitSymbol(measure: string): string {
    return measure && measure !== 'unitless' ? this.unitsService.getUnitDisplaySymbol(measure) : '';
  }

  // Express an SI (m/s) speed in the value's own display unit, so a threshold or change-step compares
  // as a true physical speed regardless of the unit the value is rendered in.
  private speedInDisplayUnit(measure: string, speedMs: number): number {
    return measure ? (this.unitsService.convertToUnit(measure, speedMs) ?? speedMs) : speedMs;
  }

}

export interface PolarOverlayModeInputs {
  enabled: boolean;
  polarReady: boolean;
  twsFresh: boolean;
  twaFresh: boolean;
  compassMode: boolean;
  headingFresh: boolean;
  /** waypointEnable on, bearing finite and fresh. */
  waypointActive: boolean;
}

/** The polar overlay's mode; the first matching rule wins. */
export function resolvePolarOverlayMode(inputs: PolarOverlayModeInputs): PolarOverlayMode {
  if (!inputs.enabled || !inputs.polarReady) return 'hidden';
  if (!inputs.twsFresh || !inputs.twaFresh) return 'hidden';
  if (inputs.compassMode && inputs.headingFresh && inputs.waypointActive) return 'vmc';
  return 'polar';
}

/** Unsigned smallest difference between two angles in rad. */
function radianDelta(a: number, b: number): number {
  return Math.abs(normalizeRadians(b - a + Math.PI) - Math.PI);
}

function addHeadingDeg(h1: number, h2: number): number {
  let h3 = (h1 + h2) % 360;
  if (h3 < 0) h3 += 360;
  return h3;
}

/**
 * Resolves the base angle to display for the configured true-wind path.
 *
 * `angleTrueWater` / `angleTrueGround` are boat-relative (true wind ANGLE). In enhanced/compass
 * mode the dial rotates with heading, so for those paths the heading is added to convert the angle
 * into a compass-frame true wind DIRECTION before rendering. In simple (bow-fixed) mode the dial
 * does not rotate, so the angle must stay boat-relative - matching apparent wind - otherwise it is
 * displaced by the heading (#1066, #1063). Direction-style paths are always passed through unchanged.
 */
export function computeTrueWindBaseAngle(path: string, value: number, heading: number, compassModeEnabled: boolean): number {
  const isBoatRelativeTrueWind = path.includes('angleTrueWater') || path.includes('angleTrueGround');
  return isBoatRelativeTrueWind && compassModeEnabled ? addHeadingDeg(heading, value) : value;
}
