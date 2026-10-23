'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const build = path.join(__dirname, '..', 'build');
const pkg = require('../package.json');

test('native signing profiles contain only the required entitlements', () => {
    const helper = fs.readFileSync(path.join(build, 'entitlements.live-helper.plist'), 'utf8');
    const runner = fs.readFileSync(path.join(build, 'entitlements.runner.plist'), 'utf8');
    assert.deepEqual([...helper.matchAll(/<key>(.*?)<\/key>/g)].map((m) => m[1]), ['com.apple.security.personal-information.calendars']);
    assert.doesNotMatch(runner, /<key>/);
    assert.match(pkg.scripts['build:helper'], /--entitlements ..\/build\/entitlements.live-helper.plist/);
    assert.match(pkg.scripts['build:runner'], /--entitlements build\/entitlements.runner.plist/);
    assert.equal(pkg.build.mac.sign, 'build/sign-mac.cjs');
    assert.equal(pkg.build.mac.entitlementsInherit, 'build/entitlements.mac.inherit.plist');
});

test('packaging re-signs native code with minimal profiles and preserves Chromium options', async () => {
    let signed;
    const sandbox = {
        module: { exports: {} },
        __dirname: build,
        require(name) {
            if (name === 'node:path') return path;
            assert.equal(name, 'app-builder-lib/out/codeSign/macCodeSign');
            return { sign: async (options) => { signed = options; } };
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(build, 'sign-mac.cjs'), 'utf8'), sandbox);
    const app = '/tmp/Example.app';
    const defaults = { entitlements: 'chromium.plist', hardenedRuntime: true, timestamp: 'timestamp', additionalArguments: ['--strict'] };
    await sandbox.module.exports({ app, identity: 'identity', optionsForFile: () => defaults });
    assert.equal(signed.identity, 'identity');
    for (const file of ['unlimeety-live', 'llama-runner', 'libggml-metal.dylib', 'libllama.0.dylib']) {
        const options = signed.optionsForFile(`${app}/Contents/MacOS/${file}`);
        assert.equal(options.entitlements, path.join(build, file === 'unlimeety-live' ? 'entitlements.live-helper.plist' : 'entitlements.runner.plist'));
        assert.equal(options.hardenedRuntime, true);
        assert.equal(options.timestamp, defaults.timestamp);
        assert.equal(options.additionalArguments, defaults.additionalArguments);
    }
    for (const file of [app, `${app}/Contents/Frameworks/Electron Framework.framework`, `${app}/Contents/Frameworks/Example Helper.app`, `${app}/Contents/Resources/libexample.dylib`]) {
        assert.equal(signed.optionsForFile(file), defaults);
    }
});
