import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { WidgetMetadataDirective } from './widget-metadata.directive';
import { DataService } from '../services/data.service';
import { SignalKDeltaService } from '../services/signalk-delta.service';
import { IMeta, IPathValueData } from '../interfaces/app-interfaces';
import { ISignalKDataValueUpdate, ISkMetadata, States } from '../interfaces/signalk-interfaces';
import { IWidgetSvcConfig } from '../interfaces/widgets-interface';

@Component({ selector: 'metadata-host', template: '', hostDirectives: [WidgetMetadataDirective] })
class MetadataHostComponent {
  readonly metadata = inject(WidgetMetadataDirective);
}

describe('WidgetMetadataDirective displayScale', () => {
  let meta: BehaviorSubject<ISkMetadata | null>;
  let metadata: WidgetMetadataDirective;

  beforeEach(() => {
    meta = new BehaviorSubject<ISkMetadata | null>(null);
    TestBed.configureTestingModule({
      imports: [MetadataHostComponent],
      providers: [{ provide: DataService, useValue: { getPathMetaObservable: () => meta } }]
    });
    metadata = TestBed.createComponent(MetadataHostComponent).componentInstance.metadata;
    metadata.setMetaConfig({ paths: { gaugePath: { description: '', path: 'self.propulsion.main.revolutions', source: null, pathType: 'number', isPathConfigurable: true } } });
  });

  it('is undefined before a path is observed and while its meta has no scale', () => {
    expect(metadata.displayScale()).toBeUndefined();
    metadata.observe('gaugePath');
    meta.next({ units: 'Hz' } as ISkMetadata);
    expect(metadata.displayScale()).toBeUndefined();
  });

  it("carries the observed path's meta displayScale, in SI", () => {
    metadata.observe('gaugePath');
    meta.next({ units: 'Hz', displayScale: { lower: 0, upper: 60, type: 'linear' } } as ISkMetadata);
    expect(metadata.displayScale()).toEqual({ lower: 0, upper: 60, type: 'linear' });
  });

  it('clears on reset', () => {
    metadata.observe('gaugePath');
    meta.next({ units: 'Hz', displayScale: { lower: 0, upper: 60, type: 'linear' } } as ISkMetadata);
    metadata.reset();
    expect(metadata.displayScale()).toBeUndefined();
  });
});

const POSITION_META: ISkMetadata = {
  description: 'Position',
  supportsPut: true,
  zones: [{ lower: 0, upper: 10, state: States.Alarm, message: 'Too far north' }],
  properties: {
    latitude: { type: 'number', units: 'deg', description: 'Latitude' },
    longitude: { type: 'number', units: 'deg', description: 'Longitude' },
  },
};

function cfgFor(path: string): IWidgetSvcConfig {
  return {
    displayName: 'Test',
    filterSelfPaths: true,
    paths: {
      p: {
        description: 'Test path',
        path,
        pathID: 'id-1',
        source: null,
        pathType: 'number',
        isPathConfigurable: true,
        showPathSkUnitsFilter: false,
        pathSkUnitsFilter: null,
        convertUnitTo: undefined as unknown as string,
        supportsPut: false,
      },
    },
  } as IWidgetSvcConfig;
}

describe('WidgetMetadataDirective', () => {
  let directive: WidgetMetadataDirective;
  let metadataUpdates$: Subject<IMeta>;

  const pushPositionMeta = () =>
    metadataUpdates$.next({ context: 'self', path: 'navigation.position', meta: POSITION_META });

  beforeEach(() => {
    metadataUpdates$ = new Subject<IMeta>();
    TestBed.configureTestingModule({
      providers: [
        WidgetMetadataDirective,
        DataService,
        {
          provide: SignalKDeltaService,
          useValue: {
            subscribeDataPathsUpdates: () => new Subject<IPathValueData>().asObservable(),
            subscribeMetadataUpdates: () => metadataUpdates$.asObservable(),
            subscribeNotificationsUpdates: () => new Subject<ISignalKDataValueUpdate>().asObservable(),
            subscribeSelfUpdates: () => new Subject<string>().asObservable(),
          },
        },
      ],
    });
    directive = TestBed.inject(WidgetMetadataDirective);
  });

  it('reports the zones and supportsPut of a plain path', () => {
    directive.setMetaConfig(cfgFor('self.navigation.position'));
    directive.observe();
    pushPositionMeta();

    expect(directive.zones()).toEqual(POSITION_META.zones);
    expect(directive.supportsPut()).toBe(true);
  });

  it('reports no zones and no supportsPut for a field, even when its base path has them', () => {
    directive.setMetaConfig(cfgFor('self.navigation.position#/latitude'));
    directive.observe();
    pushPositionMeta();

    expect(directive.zones()).toEqual([]);
    expect(directive.supportsPut()).toBe(false);
  });

  it('follows a re-point from a field to its base path', () => {
    directive.setMetaConfig(cfgFor('self.navigation.position#/latitude'));
    directive.observe();
    pushPositionMeta();

    directive.applyMetaConfigDiff(cfgFor('self.navigation.position'));

    expect(directive.zones()).toEqual(POSITION_META.zones);
  });

  it('reports nothing for a malformed pointer, without throwing', () => {
    directive.setMetaConfig(cfgFor('self.navigation.position#latitude'));

    expect(() => directive.observe()).not.toThrow();
    pushPositionMeta();
    expect(directive.zones()).toEqual([]);
  });
});
