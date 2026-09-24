import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsNotificationsComponent } from './notifications.component';
import { SettingsService } from '../../../services/settings.service';

describe('SettingsNotificationsComponent', () => {
  let component: SettingsNotificationsComponent;
  let fixture: ComponentFixture<SettingsNotificationsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsNotificationsComponent]
    })
      .compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(SettingsNotificationsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('reads the connection-sound option as off when a stored config predates it', () => {
    const settings = TestBed.inject(SettingsService);
    // Clone: getNotificationConfig() hands back the live config object, and deleting from it
    // would strip the field from the shared default for every later test in this worker.
    const stored = structuredClone(settings.getNotificationConfig());
    delete stored.sound.playConnectionSound;
    vi.spyOn(settings, 'getNotificationConfig').mockReturnValue(stored);

    const legacy = TestBed.createComponent(SettingsNotificationsComponent).componentInstance;

    expect(legacy.notificationConfig.sound.playConnectionSound).toBe(false);
  });

  afterEach(() => vi.restoreAllMocks());
});
