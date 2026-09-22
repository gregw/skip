import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { WidgetRuntimeDirective } from './widget-runtime.directive';
import type { IWidgetSvcConfig } from '../interfaces/widgets-interface';

/**
 * The merge is what a placed widget actually runs on: its defaults under the config that
 * was saved with it on the dashboard.
 */
describe('WidgetRuntimeDirective config merge', () => {
  const build = (base: IWidgetSvcConfig, saved: IWidgetSvcConfig) =>
    TestBed.runInInjectionContext(() => {
      const d = new WidgetRuntimeDirective();
      d.initialize(base, saved);
      return d.options();
    });

  it('keeps the saved value for an editable path', () => {
    const merged = build(
      { paths: { p: { description: 'P', path: 'self.a', source: 'default', pathType: 'number', isPathConfigurable: true } } },
      { paths: { p: { description: 'P', path: 'self.b', source: 'default', pathType: 'number', isPathConfigurable: true } } }
    );
    expect(merged?.paths?.['p'].path).toBe('self.b');
  });

  /**
   * The regression this exists for: a widget placed on a dashboard stored the path its
   * release happened to use, and because the path is fixed — not shown in the options
   * dialog, not editable — a later correction to the widget's defaults could never reach
   * it. The stored value is not a choice, so it does not get to win.
   */
  it('takes a fixed path back from the defaults', () => {
    const merged = build(
      { paths: { p: { description: 'P', path: 'self.racing.lines', source: 'default', pathType: 'object', isPathConfigurable: false, enableTimeout: false } } },
      { paths: { p: { description: 'P', path: 'self.racing.lines.lines', source: 'default', pathType: null, isPathConfigurable: false } } }
    );
    expect(merged?.paths?.['p'].path).toBe('self.racing.lines');
    expect(merged?.paths?.['p'].pathType).toBe('object');
    expect(merged?.paths?.['p'].enableTimeout).toBe(false);
  });

  it('leaves a fixed path that offers options alone, the stored one being a choice', () => {
    const merged = build(
      {
        paths: {
          p: {
            description: 'P', path: 'self.headingTrue', source: 'default', pathType: 'number',
            isPathConfigurable: false,
            pathOptions: [{ label: 'True', path: 'self.headingTrue' }, { label: 'Magnetic', path: 'self.headingMagnetic' }]
          }
        }
      },
      { paths: { p: { description: 'P', path: 'self.headingMagnetic', source: 'default', pathType: 'number', isPathConfigurable: false } } }
    );
    expect(merged?.paths?.['p'].path).toBe('self.headingMagnetic');
  });

  it('leaves the editable parts of a fixed path alone', () => {
    const merged = build(
      { paths: { p: { description: 'P', path: 'self.len', source: 'default', pathType: 'number', isPathConfigurable: false, convertUnitTo: 'm' } } },
      { paths: { p: { description: 'P', path: 'self.len', source: 'n2k', pathType: 'number', isPathConfigurable: false, convertUnitTo: 'feet' } } }
    );
    expect(merged?.paths?.['p'].convertUnitTo).toBe('feet');
    expect(merged?.paths?.['p'].source).toBe('n2k');
  });

  /**
   * Whether a path keeps the widget's unit or follows the server's preference is the
   * widget's own decision, not a stored choice — a widget corrected to hold metres must
   * not be dragged back to the server's nautical miles by what was saved with it.
   */
  it('takes a fixed path’s unit policy back from the defaults', () => {
    const merged = build(
      { paths: { p: { description: 'P', path: 'self.len', source: 'default', pathType: 'number', isPathConfigurable: false, convertUnitTo: 'm', showConvertUnitTo: false } } },
      { paths: { p: { description: 'P', path: 'self.len', source: 'default', pathType: 'number', isPathConfigurable: false, convertUnitTo: 'm', showConvertUnitTo: true } } }
    );
    expect(merged?.paths?.['p'].showConvertUnitTo).toBe(false);
  });
});
