import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { WidgetMetadataDirective } from './widget-metadata.directive';
import { DataService } from '../services/data.service';
import { ISkMetadata } from '../interfaces/signalk-interfaces';

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
