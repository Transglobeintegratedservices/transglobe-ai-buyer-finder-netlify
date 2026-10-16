'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, queriesFor, validateLead, canonicalLink } = require('../server');

test('classifies explicit supplier request as active buyer when relevant', () => {
  const x = classify({ title: 'Request for quotation: topsoil supply in Lagos', snippet: 'Supplier needed for topsoil supply' }, 'topsoil', 'both');
  assert.ok(x); assert.equal(x.intent, 'Active Buyer'); assert.ok(x.score >= 60);
});
test('filters irrelevant results and active-only mode excludes potential projects', () => {
  assert.equal(classify({ title: 'Football match results', snippet: 'League table' }, 'topsoil', 'both'), null);
  assert.equal(classify({ title: 'New residential estate development in Lagos', snippet: 'Construction project announced' }, 'topsoil', 'active'), null);
});
test('query builder limits queries and includes requested location', () => {
  const q = queriesFor({ location: 'Lagos, Nigeria', mode: 'both', selectedServices: ['topsoil', 'landscaping', 'haulage'], extraQuery: 'estate soil request' });
  assert.ok(q.length <= 8); assert.ok(q.every(x => x.query.includes('Lagos, Nigeria'))); assert.equal(q[0].query.includes('estate soil request'), true);
});
test('validates source URLs and required lead name', () => {
  assert.throws(() => validateLead({ name: 'Example', source: 'javascript:alert(1)' }), /HTTPS/);
  assert.throws(() => validateLead({ name: '' }), /required/);
  assert.equal(validateLead({ name: 'Example Co', source: 'https://example.com' }).source, 'https://example.com/');
});
test('canonical URL removes tracking parameters and fragments', () => {
  assert.equal(canonicalLink('https://example.com/page?utm_source=test&x=1#top'), 'https://example.com/page?x=1');
});
