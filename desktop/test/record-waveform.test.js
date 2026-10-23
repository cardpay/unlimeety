'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../renderer/record/record.js'), 'utf8');
const waveform = source.slice(source.indexOf('    let waveRaf = null;'),
    source.indexOf('    function fillRecordFileCard()'));

function harness() {
    let nextId = 0, reduced = false;
    const frames = new Map();
    const host = { replaceChildren(svg) { this.svg = svg; } };
    const context = vm.createContext({
        $: () => host,
        document: { createElementNS(ns, tag) {
            return { tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
                appendChild(child) { this.child = child; } };
        } },
        window: { matchMedia: () => ({ matches: reduced }) },
        performance: { now: () => 0 },
        requestAnimationFrame(fn) { frames.set(++nextId, fn); return nextId; },
        cancelAnimationFrame(id) { frames.delete(id); },
    });
    vm.runInContext(waveform, context);
    return {
        host, frames,
        build() { vm.runInContext('buildWaveform()', context); },
        reduceMotion() { reduced = true; },
        frame(now) {
            const [id, fn] = frames.entries().next().value;
            frames.delete(id);
            fn(now);
        },
        points() {
            return [...host.svg.child.attrs.d.matchAll(/[ML]([\d.]+),([\d.-]+)/g)]
                .map(([, x, y]) => ({ x: +x, y: +y }));
        },
    };
}

test('record waveform stays within its viewport and peaks around the central lens', () => {
    const h = harness();
    h.build();
    assert.equal(h.host.svg.tag, 'svg');
    assert.equal(h.host.svg.child.tag, 'path');
    let center = 0, edge = 0;
    for (let frame = 0; frame < 30; frame++) {
        const points = h.points();
        assert.equal(points.length, 881);
        for (const { x, y } of points) {
            assert.ok(Number.isFinite(y) && y > 0 && y < 250);
            if (x > 165 && x < 275) center = Math.max(center, Math.abs(y - 125));
            if (x < 100 || x > 340) edge = Math.max(edge, Math.abs(y - 125));
        }
        h.frame(frame * 1000 / 60);
    }
    assert.ok(center > edge * 2, `central peak ${center}, outer peak ${edge}`);
});

test('record waveform irregularities travel right without frame-dependent backtracking', () => {
    const h = harness();
    h.build();
    function crossings() {
        const points = h.points(), result = [];
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1], b = points[i];
            if (a.x < 20 || b.x > 95) continue;
            if (a.y <= 125 && b.y > 125) {
                result.push(a.x + (125 - a.y) / (b.y - a.y) * (b.x - a.x));
            }
        }
        return result;
    }
    const before = crossings();
    assert.ok(before.length > 4);
    h.frame(1000 / 60);
    const after = crossings();
    for (const x of before.filter(x => x < 90)) {
        const nearest = after.reduce((best, next) => Math.abs(next - x) < Math.abs(best - x) ? next : best);
        assert.ok(nearest > x && nearest - x < 1, `crossing ${x} moved to ${nearest}`);
    }
});

test('rebuilding keeps one animation loop and reduced motion leaves a static wave', () => {
    const h = harness();
    h.build();
    const original = h.frames.keys().next().value;
    h.build();
    assert.equal(h.frames.size, 1);
    assert.ok(!h.frames.has(original));
    h.reduceMotion();
    h.build();
    assert.equal(h.frames.size, 0);
    assert.equal(h.points().length, 881);
});
