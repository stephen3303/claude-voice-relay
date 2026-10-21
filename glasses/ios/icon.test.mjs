import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// App Store upload rejects an icon with an alpha channel (ITMS-90717), and only at upload time.
test('app icon is a 1024x1024 opaque RGB PNG', () => {
  const png = readFileSync(new URL('./GlassesRelay/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png', import.meta.url));
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 1024, 'width');
  assert.equal(png.readUInt32BE(20), 1024, 'height');
  assert.equal(png[25], 2, 'colour type 2 (RGB, no alpha)');
});
