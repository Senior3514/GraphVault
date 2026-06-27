import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chooseInstallAffordance,
  detectIosFromNavigator,
  detectPlatform,
  isIosSafari,
  isStandalone,
} from './install';

// Real-world-ish user-agent strings.
const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1',
  iphoneFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0',
} as const;

test('detectPlatform classifies the major platforms', () => {
  assert.equal(detectPlatform(UA.iphoneSafari), 'ios');
  assert.equal(detectPlatform(UA.iphoneChrome), 'ios');
  assert.equal(detectPlatform(UA.androidChrome), 'android');
  assert.equal(detectPlatform(UA.desktopChrome), 'desktop');
  assert.equal(detectPlatform(UA.macSafari), 'desktop');
  assert.equal(detectPlatform('some random string'), 'unknown');
});

test('isIosSafari is true only for genuine iOS Safari', () => {
  assert.equal(isIosSafari(UA.iphoneSafari), true);
  assert.equal(isIosSafari(UA.iphoneChrome), false, 'Chrome on iOS is not Safari');
  assert.equal(isIosSafari(UA.iphoneFirefox), false, 'Firefox on iOS is not Safari');
  assert.equal(isIosSafari(UA.androidChrome), false);
  assert.equal(isIosSafari(UA.macSafari), false, 'desktop Safari cannot Add to Home Screen');
});

test('detectIosFromNavigator catches iPadOS 13+ desktop-UA masquerade', () => {
  assert.equal(detectIosFromNavigator({ userAgent: UA.iphoneSafari }), true);
  assert.equal(
    detectIosFromNavigator({ userAgent: UA.macSafari, maxTouchPoints: 5, platform: 'MacIntel' }),
    true,
    'iPad reporting macOS UA but with touch is iOS',
  );
  assert.equal(
    detectIosFromNavigator({ userAgent: UA.macSafari, maxTouchPoints: 0, platform: 'MacIntel' }),
    false,
    'a real Mac with no touch is not iOS',
  );
  assert.equal(detectIosFromNavigator({ userAgent: UA.desktopChrome }), false);
});

test('chooseInstallAffordance: standalone always wins → none', () => {
  assert.equal(
    chooseInstallAffordance({
      userAgent: UA.androidChrome,
      standalone: true,
      hasPromptEvent: true,
    }),
    'none',
  );
  assert.equal(
    chooseInstallAffordance({
      userAgent: UA.iphoneSafari,
      standalone: true,
      hasPromptEvent: false,
    }),
    'none',
  );
});

test('chooseInstallAffordance: a captured prompt event → prompt', () => {
  assert.equal(
    chooseInstallAffordance({
      userAgent: UA.androidChrome,
      standalone: false,
      hasPromptEvent: true,
    }),
    'prompt',
  );
  assert.equal(
    chooseInstallAffordance({
      userAgent: UA.desktopChrome,
      standalone: false,
      hasPromptEvent: true,
    }),
    'prompt',
  );
  assert.equal(
    chooseInstallAffordance({ userAgent: UA.edge, standalone: false, hasPromptEvent: true }),
    'prompt',
  );
});

test('chooseInstallAffordance: iOS Safari without prompt → ios-hint', () => {
  assert.equal(
    chooseInstallAffordance({
      userAgent: UA.iphoneSafari,
      standalone: false,
      hasPromptEvent: false,
    }),
    'ios-hint',
  );
});

test('chooseInstallAffordance: other no-prompt browsers → manual-hint', () => {
  assert.equal(
    chooseInstallAffordance({ userAgent: UA.macSafari, standalone: false, hasPromptEvent: false }),
    'manual-hint',
  );
  assert.equal(
    chooseInstallAffordance({
      userAgent: UA.iphoneChrome,
      standalone: false,
      hasPromptEvent: false,
    }),
    'manual-hint',
    'Chrome on iOS cannot prompt and is not Safari → manual hint',
  );
});

test('isStandalone reads any of the standalone signals', () => {
  assert.equal(isStandalone({ displayModeStandalone: true }), true);
  assert.equal(isStandalone({ displayModeStandalone: false, displayModeFullscreen: true }), true);
  assert.equal(isStandalone({ displayModeStandalone: false, displayModeMinimalUi: true }), true);
  assert.equal(isStandalone({ displayModeStandalone: false, iosStandalone: true }), true);
  assert.equal(isStandalone({ displayModeStandalone: false }), false);
});
