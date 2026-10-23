'use strict';

const path = require('node:path');
const { sign } = require('app-builder-lib/out/codeSign/macCodeSign');

// electron-builder re-signs extraFiles. Override its inherited Chromium
// entitlements for the native executables and the runner's sibling dylibs.
module.exports = async function signMac(options) {
    const originalOptionsForFile = options.optionsForFile;
    return sign({
        ...options,
        optionsForFile(filePath) {
            const defaults = originalOptionsForFile(filePath);
            const relative = path.relative(options.app, filePath);
            if (relative === 'Contents/MacOS/unlimeety-live') {
                return { ...defaults, entitlements: path.join(__dirname, 'entitlements.live-helper.plist') };
            }
            if (relative === 'Contents/MacOS/llama-runner' || /^Contents\/MacOS\/lib[^/]+\.dylib$/.test(relative)) {
                return { ...defaults, entitlements: path.join(__dirname, 'entitlements.runner.plist') };
            }
            return defaults;
        },
    });
};
