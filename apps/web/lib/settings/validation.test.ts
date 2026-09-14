import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isHttpUrl, isValid, validateFields } from './validation';

test('isHttpUrl accepts well-formed http(s) URLs', () => {
  assert.equal(isHttpUrl('http://127.0.0.1:4000'), true);
  assert.equal(isHttpUrl('https://cloud.example.com/remote.php/dav/files/alice/'), true);
  assert.equal(isHttpUrl('  https://example.com  '), true); // trims
});

test('isHttpUrl rejects malformed or non-http URLs', () => {
  assert.equal(isHttpUrl(''), false);
  assert.equal(isHttpUrl('   '), false);
  assert.equal(isHttpUrl('not a url'), false);
  assert.equal(isHttpUrl('example.com'), false); // no scheme
  assert.equal(isHttpUrl('ftp://example.com'), false);
  assert.equal(isHttpUrl('file:///etc/passwd'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
});

test('validateFields flags a missing required field', () => {
  const errors = validateFields({
    region: { value: '', required: true, label: 'Region' },
  });
  assert.equal(errors.region, 'Region is required.');
  assert.equal(isValid(errors), false);
});

test('validateFields flags a malformed required URL', () => {
  const errors = validateFields({
    url: { value: 'totally-not-a-url', required: true, url: true, label: 'WebDAV URL' },
  });
  assert.equal(errors.url, 'WebDAV URL must be a valid http(s) URL.');
});

test('validateFields treats empty optional URL as valid (skips checks)', () => {
  const errors = validateFields({
    endpoint: { value: '', url: true, label: 'Endpoint URL' },
  });
  assert.deepEqual(errors, {});
  assert.equal(isValid(errors), true);
});

test('validateFields validates a non-empty optional URL', () => {
  const ok = validateFields({
    endpoint: { value: 'https://r2.example.com', url: true, label: 'Endpoint URL' },
  });
  assert.deepEqual(ok, {});

  const bad = validateFields({
    endpoint: { value: 'r2.example.com', url: true, label: 'Endpoint URL' },
  });
  assert.equal(bad.endpoint, 'Endpoint URL must be a valid http(s) URL.');
});

test('validateFields enforces endsWithSlash on prefixes', () => {
  const bad = validateFields({
    prefix: { value: 'graphvault', endsWithSlash: true, label: 'Key prefix' },
  });
  assert.equal(bad.prefix, 'Key prefix must end with "/".');

  const ok = validateFields({
    prefix: { value: 'graphvault/', endsWithSlash: true, label: 'Key prefix' },
  });
  assert.deepEqual(ok, {});
});

test('validateFields: required wins over url when empty', () => {
  const errors = validateFields({
    url: { value: '', required: true, url: true, label: 'Endpoint URL' },
  });
  assert.equal(errors.url, 'Endpoint URL is required.');
});

test('validateFields aggregates multiple field errors', () => {
  const errors = validateFields({
    region: { value: '', required: true, label: 'Region' },
    bucket: { value: 'ok', required: true, label: 'Bucket' },
    endpoint: { value: 'bad', url: true, label: 'Endpoint' },
  });
  assert.equal(Object.keys(errors).length, 2);
  assert.ok(errors.region);
  assert.ok(errors.endpoint);
  assert.equal(errors.bucket, undefined);
});
